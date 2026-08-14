import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import type { AgentRunner, AgentTurnResult } from "./agent-runner.js";
import { CheckpointRepository } from "./checkpoints.js";
import { prepareAgentCodexHome } from "./codex-home.js";
import {
  addUsage,
  agentOutcomeWireSchema,
  agentOutcomeSchema,
  emptyUsage,
  fastWorkerOutcomeWireSchema,
  fastWorkerOutcomeSchema,
  modelProfiles,
  orchestrationPlanWireSchema,
  orchestrationPlanSchema,
  storedOrchestrationPlanSchema,
  verificationOutcomeWireSchema,
  verificationOutcomeSchema,
  workflowRunInputSchema,
  workflowRunOutputSchema,
  type AgentOutcome,
  type AgentUsage,
  type ExecutionRoute,
  type FastWorkerOutcome,
  type ModelProfile,
  type OrchestrationPlan,
  type ParsedWorkflowRunInput,
  recoveryDecisionInputSchema,
  recoveryDecisionOutputSchema,
  type RecoveryDecisionInput,
  type RecoveryDecisionOutput,
  type StoredOrchestrationPlan,
  type UsageStatus,
  type VerificationEvidenceReference,
  type WorkflowFailureKind,
  type VerificationOutcome,
  type WorkflowRunInput,
  type WorkflowRunOutput,
} from "./contracts.js";
import {
  createAgentJournal,
  ensureFailureResult,
  ensureResult,
  ensureStructuredJournal,
  ensureVerificationResult,
  freezeResult,
  prepareResultForTurn,
  restoreAgentJournal,
  type AgentJournalPaths,
} from "./journal.js";
import {
  type LifecycleHookMetadata,
  writeLifecycleHookMetadata,
} from "./lifecycle-hook.js";
import {
  finalOrchestratorPrompt,
  fastWorkerPrompt,
  initialOrchestratorPrompt,
  verifierPrompt,
  workerPrompt,
} from "./prompts.js";
import {
  recoverFastWorkerPrompt,
  recoverFinalOrchestratorPrompt,
  recoverOrchestratorPlanningPrompt,
  recoverVerifierPrompt,
  recoverWorkerPrompt,
} from "./recovery-prompts.js";
import {
  StateStore,
  type StoredAgentRun,
  type StoredWorkflow,
  type WorkflowLease,
  WorkflowLeaseLostError,
} from "./state.js";

export interface WorkflowControllerOptions {
  stateDir: string;
  runner: AgentRunner;
  gitPath?: string;
  leaseMs?: number;
}

/**
 * Testable representation of a Controller process disappearing mid-workflow.
 *
 * Real process termination never reaches the Controller catch block. Rethrowing
 * this sentinel lets recovery tests exercise the same durable state without
 * converting the Workflow Run into a terminal execution failure.
 */
export class WorkflowInterruptedError extends Error {
  constructor(message = "Workflow Controller process was interrupted") {
    super(message);
    this.name = "WorkflowInterruptedError";
  }
}

interface AgentCompletionPayload<T> {
  thread_id: string;
  outcome: T;
  usage: AgentUsage | null;
}

interface PreparedRun {
  run: StoredAgentRun;
  journal: AgentJournalPaths;
  codexHome: string;
}

interface UsageSummary {
  usage: AgentUsage;
  status: UsageStatus;
}

interface TerminalOutcome {
  status: WorkflowRunOutput["status"];
  summary: string;
  result_path: string | null;
  questions: string[];
  blocker: string | null;
}

const ORCHESTRATOR_PROFILE: ModelProfile = "sol_high";
const FAST_WORKER_PROFILE: ModelProfile = "luna_high";
const FAST_VERIFIER_PROFILE: ModelProfile = "luna_high";
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_BACKEND_SERVICE_TIER = "default";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedOutcome(
  outcome: AgentOutcome,
  resultPath: string,
): AgentOutcome {
  return { ...outcome, result_path: resultPath };
}

function normalizedVerificationOutcome(
  outcome: VerificationOutcome,
  resultPath: string,
): VerificationOutcome {
  return { ...outcome, result_path: resultPath };
}

function normalizedFastOutcome(
  outcome: FastWorkerOutcome,
  resultPath: string,
): FastWorkerOutcome {
  return { ...outcome, result_path: resultPath };
}

function sumRunUsage(runs: StoredAgentRun[]): AgentUsage {
  const latestByRun = runs.map((run) => run.usage);
  return latestByRun.reduce(addUsage, emptyUsage());
}

function aggregateUsage(runs: StoredAgentRun[]): UsageSummary {
  const usage = sumRunUsage(runs);
  if (runs.length === 0 || runs.every((run) => run.usageStatus === "unknown")) {
    return { usage, status: "unknown" };
  }
  if (runs.every((run) => run.usageStatus === "measured")) {
    return { usage, status: "measured" };
  }
  if (runs.every((run) => run.usageStatus === "estimated")) {
    return { usage, status: "estimated" };
  }
  return { usage, status: "partial" };
}

function successfulUsageStatus(
  previous: UsageStatus,
  current: AgentUsage | null,
): UsageStatus {
  if (current !== null) {
    return "measured";
  }
  return previous === "measured" ? "partial" : previous;
}

function failedUsageStatus(run: StoredAgentRun): UsageStatus {
  return run.usageStatus === "unknown" ? "unknown" : "partial";
}

function classifyFailure(message: string): WorkflowFailureKind {
  const normalized = message.toLowerCase();
  return normalized.includes("cyber_policy") ||
    normalized.includes("flagged for possible cybersecurity risk") ||
    normalized.includes("chatgpt.com/cyber")
    ? "cyber_policy"
    : "execution_error";
}

function pathIsWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validatedVerificationOutcome(
  outcome: VerificationOutcome,
  workspace: string,
  taskDir: string,
): VerificationOutcome {
  if (outcome.status !== "passed") {
    return outcome;
  }

  const valid: VerificationEvidenceReference[] = [];
  const invalid: string[] = [];
  if (outcome.evidence_references.length === 0) {
    invalid.push("Verification returned passed without an Evidence Reference");
  }
  for (const reference of outcome.evidence_references) {
    if (!isAbsolute(reference.artifact_path)) {
      invalid.push(
        `Evidence Reference for ${reference.claim} is not an absolute path: ${reference.artifact_path}`,
      );
      continue;
    }
    const artifactPath = resolve(reference.artifact_path);
    if (
      !pathIsWithin(workspace, artifactPath) &&
      !pathIsWithin(taskDir, artifactPath)
    ) {
      invalid.push(
        `Evidence Reference for ${reference.claim} is outside the Workspace and Workflow task directory: ${artifactPath}`,
      );
      continue;
    }
    try {
      if (!lstatSync(artifactPath).isFile()) {
        invalid.push(
          `Evidence Reference for ${reference.claim} is not a regular file: ${artifactPath}`,
        );
        continue;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      invalid.push(
        `Evidence Reference for ${reference.claim} cannot be read: ${artifactPath} (${detail})`,
      );
      continue;
    }
    valid.push({ ...reference, artifact_path: artifactPath });
  }

  if (invalid.length === 0) {
    return { ...outcome, evidence_references: valid };
  }
  return verificationOutcomeSchema.parse({
    status: "findings",
    summary:
      "Independent verification did not provide durable evidence sufficient for completion.",
    findings: invalid.map((issue) => ({
      issue,
      evidence:
        "The Controller rejected the passed outcome at the Evidence Reference gate.",
    })),
    evidence_references: valid,
    result_path: outcome.result_path,
    questions: [],
    blocker: null,
  });
}

export class WorkflowController {
  readonly stateDir: string;
  readonly store: StateStore;
  private readonly checkpointsDir: string;
  private readonly codexHomesDir: string;
  private readonly gitPath: string;
  private readonly leaseMs: number;
  private readonly runner: AgentRunner;
  private readonly stateDatabase: string;
  private readonly tasksDir: string;

  constructor(options: WorkflowControllerOptions) {
    this.stateDir = resolve(options.stateDir);
    this.tasksDir = join(this.stateDir, "tasks");
    this.checkpointsDir = join(this.stateDir, "checkpoints");
    this.codexHomesDir = join(this.stateDir, "codex-homes");
    this.gitPath = options.gitPath ?? "git";
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.stateDatabase = join(this.stateDir, "controller.sqlite3");
    mkdirSync(this.tasksDir, { recursive: true });
    mkdirSync(this.checkpointsDir, { recursive: true });
    mkdirSync(this.codexHomesDir, { recursive: true });
    this.store = new StateStore(this.stateDatabase);
    this.runner = options.runner;
  }

  close(): void {
    this.store.close();
  }

  recordRecoveryDecision(
    rawInput: RecoveryDecisionInput,
  ): RecoveryDecisionOutput {
    const input = recoveryDecisionInputSchema.parse(rawInput);
    return recoveryDecisionOutputSchema.parse(
      this.store.recordRecoveryDecision(input),
    );
  }

  async run(
    rawInput: WorkflowRunInput,
    signal?: AbortSignal,
  ): Promise<WorkflowRunOutput> {
    const input = workflowRunInputSchema.parse(rawInput);
    const workspace = resolve(input.workspace ?? process.cwd());
    if (!statSync(workspace).isDirectory()) {
      throw new Error(`Workspace is not a directory: ${workspace}`);
    }

    const workflowId = input.workflow_id ?? randomUUID();
    const taskDir = join(this.tasksDir, workflowId);
    const created = this.store.createWorkflowIfAbsent(
      workflowId,
      input.request,
      workspace,
      taskDir,
      input.execution_route,
      input.completion_criteria,
      emptyUsage(),
    );
    const workflow = this.store.getStoredWorkflow(workflowId);
    if (workflow === undefined) {
      throw new Error(`Failed to persist workflow ${workflowId}`);
    }
    this.assertWorkflowIdentity(workflow, input, workspace);

    const terminal = this.store.terminalOutput(workflowId);
    if (terminal !== null) {
      return terminal;
    }

    const lease = this.store.claimWorkflow(
      workflowId,
      randomUUID(),
      this.leaseMs,
    );
    if (lease === null) {
      throw new Error(
        `Workflow ${workflowId} is already being executed by another Controller`,
      );
    }
    const leaseAbort = new AbortController();
    const turnSignal = signal
      ? AbortSignal.any([signal, leaseAbort.signal])
      : leaseAbort.signal;
    let heartbeat: NodeJS.Timeout | null = null;
    let interrupted = false;
    let leaseLost = false;
    try {
      heartbeat = setInterval(() => {
        if (!this.store.heartbeatWorkflow(lease, this.leaseMs)) {
          leaseLost = true;
          leaseAbort.abort(new WorkflowLeaseLostError(workflowId));
        }
      }, Math.max(10, Math.floor(this.leaseMs / 3)));
      heartbeat.unref();

      if (created) {
        this.store.appendEvent(lease, null, "workflow.started", {
          workspace,
          task_dir: taskDir,
          execution_route: input.execution_route,
          lease_epoch: lease.epoch,
        });
      } else {
        this.store.appendEvent(lease, null, "workflow.resumed", {
          lease_epoch: lease.epoch,
        });
      }

      const repository = this.checkpointRepository(workflowId, taskDir);
      if (!created) {
        this.restoreResumableArtifacts(workflow, repository, lease);
      }
      return input.execution_route === "single_worker"
        ? await this.runSingleWorker(
            workflow,
            input,
            repository,
            lease,
            turnSignal,
          )
        : await this.runOrchestrated(
            workflow,
            input,
            repository,
            lease,
            turnSignal,
          );
    } catch (error) {
      if (error instanceof WorkflowInterruptedError) {
        interrupted = true;
        throw error;
      }
      if (leaseLost || error instanceof WorkflowLeaseLostError) {
        interrupted = true;
        const terminalAfterTakeover = this.store.terminalOutput(workflowId);
        if (terminalAfterTakeover !== null) {
          return terminalAfterTakeover;
        }
        throw error instanceof WorkflowLeaseLostError
          ? error
          : new WorkflowLeaseLostError(workflowId);
      }
      if (signal?.aborted) {
        return this.cancelWorkflow(
          lease,
          taskDir,
          input.execution_route,
          "Workflow execution was cancelled",
        );
      }
      return this.failWorkflow(
        lease,
        taskDir,
        input.execution_route,
        errorMessage(error),
      );
    } finally {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
      }
      if (!interrupted) {
        this.store.releaseWorkflow(lease);
      }
    }
  }

  private async runOrchestrated(
    workflow: StoredWorkflow,
    input: ParsedWorkflowRunInput,
    repository: CheckpointRepository,
    lease: WorkflowLease,
    signal?: AbortSignal,
  ): Promise<WorkflowRunOutput> {
    const orchestrator = this.ensureOrchestratorRun(
      workflow,
      repository,
      lease,
    );
    let plan = this.completedOutcome<StoredOrchestrationPlan>(
      workflow.id,
      "orchestrator.planned",
      storedOrchestrationPlanSchema,
    );
    if (plan === null) {
      const turn = await this.executeAgentTurn<OrchestrationPlan>(
        lease,
        orchestrator,
        orchestrator.run.threadId === null
          ? initialOrchestratorPrompt({
              request: input.request,
              workspace: workflow.workspace,
              journal: orchestrator.journal,
            })
          : recoverOrchestratorPlanningPrompt({
              workspace: workflow.workspace,
              journal: orchestrator.journal,
            }),
        orchestrationPlanSchema,
        orchestrationPlanWireSchema,
        signal,
      );
      plan = turn.output;
      const usage = addUsage(orchestrator.run.usage, turn.usage);
      this.store.recordAgentProgress(
        lease,
        orchestrator.run.id,
        usage,
        successfulUsageStatus(orchestrator.run.usageStatus, turn.usage),
        "orchestrator.planned",
        {
          thread_id: turn.threadId,
          outcome: plan,
          usage: turn.usage,
        },
        turn.effectiveServiceTier,
      );
    }
    this.commitCheckpoint(
      repository,
      lease,
      orchestrator.run.id,
      "orchestrator.planned",
    );

    if (plan.status !== "ready") {
      const outcome = agentOutcomeSchema.parse({
        status: plan.status,
        summary: plan.summary,
        result_path: orchestrator.journal.result,
        questions: plan.questions,
        blocker: plan.blocker,
      });
      ensureResult(orchestrator.journal.result, "orchestrator", outcome);
      const run = this.requireRun(orchestrator.run.id);
      this.store.finishAgentRun(
        lease,
        run.id,
        "completed",
        run.usage,
        run.usageStatus,
      );
      this.commitCheckpoint(
        repository,
        lease,
        orchestrator.run.id,
        `workflow.${outcome.status}`,
      );
      freezeResult(orchestrator.journal.result);
      return this.finishWorkflow(
        lease,
        workflow.taskDir,
        outcome,
        this.currentUsage(workflow.id),
        workflow.executionRoute,
      );
    }

    const worker = this.ensureWorkerRun(
      workflow,
      orchestrator.run.id,
      plan.worker_profile,
      plan.worker_task,
      plan.completion_criteria,
      repository,
      lease,
    );
    let workerOutcome = this.completedOutcome<AgentOutcome>(
      workflow.id,
      "worker.completed",
      agentOutcomeSchema,
    );
    if (workerOutcome === null) {
      const turn = await this.executeAgentTurn(
        lease,
        worker,
        worker.run.threadId === null
          ? workerPrompt({ workspace: workflow.workspace, journal: worker.journal })
          : recoverWorkerPrompt({
              workspace: workflow.workspace,
              journal: worker.journal,
            }),
        agentOutcomeSchema,
        agentOutcomeWireSchema,
        signal,
      );
      workerOutcome = normalizedOutcome(turn.output, worker.journal.result);
      ensureResult(worker.journal.result, "worker", workerOutcome, {
        preserveExisting: true,
      });
      const usage = addUsage(worker.run.usage, turn.usage);
      this.store.completeAgentRun(
        lease,
        worker.run.id,
        usage,
        successfulUsageStatus(worker.run.usageStatus, turn.usage),
        "worker.completed",
        {
          thread_id: turn.threadId,
          outcome: workerOutcome,
          usage: turn.usage,
        },
        turn.effectiveServiceTier,
      );
    }
    ensureResult(worker.journal.result, "worker", workerOutcome, {
      preserveExisting: true,
      acceptFinalized: true,
    });
    this.commitCheckpoint(
      repository,
      lease,
      worker.run.id,
      "worker.completed",
    );
    freezeResult(worker.journal.result);

    if (workerOutcome.status !== "completed") {
      this.finishRunIfRunning(lease, orchestrator.run.id);
      this.commitCheckpoint(
        repository,
        lease,
        worker.run.id,
        `workflow.${workerOutcome.status}`,
      );
      return this.finishWorkflow(
        lease,
        workflow.taskDir,
        workerOutcome,
        this.currentUsage(workflow.id),
        workflow.executionRoute,
        null,
        workerOutcome.status === "failed" ? "task_failed" : null,
      );
    }

    const verifier = this.ensureVerifierRun(
      workflow,
      orchestrator.run.id,
      plan.verifier_profile,
      plan.completion_criteria,
      repository,
      lease,
    );
    let verifierOutcome = this.completedOutcome<VerificationOutcome>(
      workflow.id,
      "verifier.completed",
      verificationOutcomeSchema,
    );
    if (verifierOutcome === null) {
      const turn = await this.executeAgentTurn(
        lease,
        verifier,
        verifier.run.threadId === null
          ? verifierPrompt({
              request: workflow.request,
              workspace: workflow.workspace,
              journal: verifier.journal,
              workerJournal: worker.journal,
              completionCriteria: plan.completion_criteria,
            })
          : recoverVerifierPrompt({
              workspace: workflow.workspace,
              journal: verifier.journal,
            }),
        verificationOutcomeSchema,
        verificationOutcomeWireSchema,
        signal,
      );
      verifierOutcome = normalizedVerificationOutcome(
        turn.output,
        verifier.journal.result,
      );
      verifierOutcome = validatedVerificationOutcome(
        verifierOutcome,
        workflow.workspace,
        workflow.taskDir,
      );
      ensureVerificationResult(verifier.journal.result, verifierOutcome, {
        preserveExisting: true,
      });
      const usage = addUsage(verifier.run.usage, turn.usage);
      this.store.completeAgentRun(
        lease,
        verifier.run.id,
        usage,
        successfulUsageStatus(verifier.run.usageStatus, turn.usage),
        "verifier.completed",
        {
          thread_id: turn.threadId,
          outcome: verifierOutcome,
          usage: turn.usage,
        },
        turn.effectiveServiceTier,
      );
    }
    verifierOutcome = validatedVerificationOutcome(
      verifierOutcome,
      workflow.workspace,
      workflow.taskDir,
    );
    ensureVerificationResult(verifier.journal.result, verifierOutcome, {
      preserveExisting: true,
      acceptFinalized: true,
    });
    this.commitCheckpoint(
      repository,
      lease,
      verifier.run.id,
      "verifier.completed",
    );
    freezeResult(verifier.journal.result);

    if (verifierOutcome.status !== "passed") {
      this.finishRunIfRunning(lease, orchestrator.run.id);
      const terminalOutcome = this.verificationTerminalOutcome(
        verifierOutcome,
        verifier.journal,
      );
      this.commitCheckpoint(
        repository,
        lease,
        verifier.run.id,
        `workflow.${terminalOutcome.status}`,
      );
      return this.finishWorkflow(
        lease,
        workflow.taskDir,
        terminalOutcome,
        this.currentUsage(workflow.id),
        workflow.executionRoute,
        null,
        verifierOutcome.status === "findings"
          ? "verification_rejected"
          : null,
      );
    }

    const latestOrchestrator = this.requireRun(orchestrator.run.id);
    if (latestOrchestrator.threadId === null) {
      throw new Error("Orchestrator planning thread ID was not persisted");
    }
    const finalEvent = this.completedOutcome<AgentOutcome>(
      workflow.id,
      "orchestrator.completed",
      agentOutcomeSchema,
    );
    let finalOutcome = finalEvent;
    if (finalOutcome === null) {
      const finalTurn = await this.executeAgentTurn(
        lease,
        { ...orchestrator, run: latestOrchestrator },
        this.store.latestEvent(workflow.id, "orchestrator.finalizing") ===
          undefined
          ? finalOrchestratorPrompt({
              workspace: workflow.workspace,
              orchestratorJournal: orchestrator.journal,
              workerJournal: worker.journal,
              workerOutcomeJson: JSON.stringify(workerOutcome, null, 2),
              verifierJournal: verifier?.journal ?? null,
              verifierOutcomeJson:
                verifierOutcome === null
                  ? null
                  : JSON.stringify(verifierOutcome, null, 2),
            })
          : recoverFinalOrchestratorPrompt({
              workspace: workflow.workspace,
              journal: orchestrator.journal,
            }),
        agentOutcomeSchema,
        agentOutcomeWireSchema,
        signal,
        "orchestrator.finalizing",
      );
      if (finalTurn.threadId !== latestOrchestrator.threadId) {
        throw new Error(
          `Codex resumed Orchestrator as a different thread: ${finalTurn.threadId}`,
        );
      }
      finalOutcome = normalizedOutcome(
        finalTurn.output,
        orchestrator.journal.result,
      );
      ensureResult(orchestrator.journal.result, "orchestrator", finalOutcome, {
        preserveExisting: true,
        evidenceReferences: verifierOutcome.evidence_references,
      });
      const usage = finalTurn.usage ?? latestOrchestrator.usage;
      this.store.completeAgentRun(
        lease,
        orchestrator.run.id,
        usage,
        successfulUsageStatus(latestOrchestrator.usageStatus, finalTurn.usage),
        "orchestrator.completed",
        {
          thread_id: finalTurn.threadId,
          outcome: finalOutcome,
          usage: finalTurn.usage,
        },
        finalTurn.effectiveServiceTier,
      );
    }
    ensureResult(orchestrator.journal.result, "orchestrator", finalOutcome, {
      preserveExisting: true,
      acceptFinalized: true,
      evidenceReferences: verifierOutcome.evidence_references,
    });
    this.commitCheckpoint(
      repository,
      lease,
      orchestrator.run.id,
      "orchestrator.completed",
    );
    freezeResult(orchestrator.journal.result);

    return this.finishWorkflow(
      lease,
      workflow.taskDir,
      finalOutcome,
      this.currentUsage(workflow.id),
      workflow.executionRoute,
      null,
      finalOutcome.status === "failed" ? "task_failed" : null,
    );
  }

  private async runSingleWorker(
    workflow: StoredWorkflow,
    input: ParsedWorkflowRunInput,
    repository: CheckpointRepository,
    lease: WorkflowLease,
    signal?: AbortSignal,
  ): Promise<WorkflowRunOutput> {
    const worker = this.ensureFastWorkerRun(workflow, repository, lease);
    let workerOutcome = this.completedOutcome<FastWorkerOutcome>(
      workflow.id,
      "worker.completed",
      fastWorkerOutcomeSchema,
    );
    if (workerOutcome === null) {
      const turn = await this.executeAgentTurn<FastWorkerOutcome>(
        lease,
        worker,
        worker.run.threadId === null
          ? fastWorkerPrompt({ workspace: workflow.workspace, journal: worker.journal })
          : recoverFastWorkerPrompt({
              workspace: workflow.workspace,
              journal: worker.journal,
            }),
        fastWorkerOutcomeSchema,
        fastWorkerOutcomeWireSchema,
        signal,
      );
      workerOutcome = normalizedFastOutcome(turn.output, worker.journal.result);
      ensureResult(worker.journal.result, "worker", workerOutcome, {
        preserveExisting: true,
      });
      const usage = addUsage(worker.run.usage, turn.usage);
      this.store.completeAgentRun(
        lease,
        worker.run.id,
        usage,
        successfulUsageStatus(worker.run.usageStatus, turn.usage),
        "worker.completed",
        {
          thread_id: turn.threadId,
          outcome: workerOutcome,
          usage: turn.usage,
        },
        turn.effectiveServiceTier,
      );
    }
    ensureStructuredJournal(worker.journal.journal, workerOutcome);
    ensureResult(worker.journal.result, "worker", workerOutcome, {
      preserveExisting: true,
      acceptFinalized: true,
    });
    this.commitCheckpoint(
      repository,
      lease,
      worker.run.id,
      "worker.completed",
    );
    freezeResult(worker.journal.result);

    if (workerOutcome.status !== "completed") {
      const retryRoute =
        workerOutcome.status === "escalate" ? "orchestrated" : null;
      const terminalOutcome = agentOutcomeSchema.parse({
        status:
          workerOutcome.status === "escalate"
            ? "failed"
            : workerOutcome.status,
        summary:
          workerOutcome.status === "escalate"
            ? `Single-Worker route requires orchestration: ${workerOutcome.summary}`
            : workerOutcome.summary,
        result_path: worker.journal.result,
        questions: workerOutcome.questions,
        blocker:
          workerOutcome.status === "escalate"
            ? "route_escalation_required"
            : workerOutcome.blocker,
      });
      this.commitCheckpoint(
        repository,
        lease,
        worker.run.id,
        retryRoute === null
          ? `workflow.${terminalOutcome.status}`
          : "workflow.escalated",
      );
      return this.finishWorkflow(
        lease,
        workflow.taskDir,
        terminalOutcome,
        this.currentUsage(workflow.id),
        "single_worker",
        retryRoute,
        workerOutcome.status === "escalate"
          ? "route_escalation"
          : workerOutcome.status === "failed"
            ? "task_failed"
            : null,
      );
    }

    const verifier = this.ensureVerifierRun(
      workflow,
      worker.run.id,
      FAST_VERIFIER_PROFILE,
      input.completion_criteria,
      repository,
      lease,
    );
    let verifierOutcome = this.completedOutcome<VerificationOutcome>(
      workflow.id,
      "verifier.completed",
      verificationOutcomeSchema,
    );
    if (verifierOutcome === null) {
      const turn = await this.executeAgentTurn<VerificationOutcome>(
        lease,
        verifier,
        verifier.run.threadId === null
          ? verifierPrompt({
              request: workflow.request,
              workspace: workflow.workspace,
              journal: verifier.journal,
              workerJournal: worker.journal,
              completionCriteria: input.completion_criteria,
              compactArtifacts: true,
            })
          : recoverVerifierPrompt({
              workspace: workflow.workspace,
              journal: verifier.journal,
            }),
        verificationOutcomeSchema,
        verificationOutcomeWireSchema,
        signal,
      );
      verifierOutcome = normalizedVerificationOutcome(
        turn.output,
        verifier.journal.result,
      );
      verifierOutcome = validatedVerificationOutcome(
        verifierOutcome,
        workflow.workspace,
        workflow.taskDir,
      );
      ensureVerificationResult(verifier.journal.result, verifierOutcome, {
        preserveExisting: true,
      });
      const usage = addUsage(verifier.run.usage, turn.usage);
      this.store.completeAgentRun(
        lease,
        verifier.run.id,
        usage,
        successfulUsageStatus(verifier.run.usageStatus, turn.usage),
        "verifier.completed",
        {
          thread_id: turn.threadId,
          outcome: verifierOutcome,
          usage: turn.usage,
        },
        turn.effectiveServiceTier,
      );
    }
    verifierOutcome = validatedVerificationOutcome(
      verifierOutcome,
      workflow.workspace,
      workflow.taskDir,
    );
    ensureStructuredJournal(verifier.journal.journal, verifierOutcome);
    ensureVerificationResult(verifier.journal.result, verifierOutcome, {
      preserveExisting: true,
      acceptFinalized: true,
    });
    this.commitCheckpoint(
      repository,
      lease,
      verifier.run.id,
      "verifier.completed",
    );
    freezeResult(verifier.journal.result);

    const terminalOutcome = this.fastTerminalOutcome(
      workerOutcome,
      verifierOutcome,
      verifier.journal,
    );
    const retryRoute =
      verifierOutcome.status === "findings" ? "orchestrated" : null;
    this.commitCheckpoint(
      repository,
      lease,
      verifier.run.id,
      retryRoute === null
        ? `workflow.${terminalOutcome.status}`
        : "workflow.escalated",
    );
    return this.finishWorkflow(
      lease,
      workflow.taskDir,
      terminalOutcome,
      this.currentUsage(workflow.id),
      "single_worker",
      retryRoute,
      verifierOutcome.status === "findings"
        ? "verification_rejected"
        : null,
    );
  }

  private ensureOrchestratorRun(
    workflow: StoredWorkflow,
    repository: CheckpointRepository,
    lease: WorkflowLease,
  ): PreparedRun {
    const existing = this.store
      .listStoredAgentRuns(workflow.id)
      .find((run) => run.role === "orchestrator");
    const journal = createAgentJournal({
      directory: join(workflow.taskDir, "orchestrator"),
      role: "orchestrator",
      workflowId: workflow.id,
      workspace: workflow.workspace,
      objective: workflow.request,
      completionCriteria: [
        "Delegate one precise task to one Generic Worker.",
        "Verify the Worker result against the original request.",
        "Produce a final outcome suitable for the Interaction Agent.",
      ],
    });
    const run =
      existing ??
      this.createRun(
        lease,
        workflow.id,
        null,
        "orchestrator",
        ORCHESTRATOR_PROFILE,
        journal,
      );
    this.commitCheckpoint(repository, lease, run.id, "workflow.accepted");
    return this.prepareRun(workflow, run, journal, lease);
  }

  private ensureFastWorkerRun(
    workflow: StoredWorkflow,
    repository: CheckpointRepository,
    lease: WorkflowLease,
  ): PreparedRun {
    const journal = createAgentJournal({
      directory: join(workflow.taskDir, "workers", "worker-1"),
      role: "worker",
      workflowId: workflow.id,
      workspace: workflow.workspace,
      objective: workflow.request,
      completionCriteria: workflow.completionCriteria,
    });
    const existing = this.store
      .listStoredAgentRuns(workflow.id)
      .find((run) => run.role === "worker");
    const run =
      existing ??
      this.createRun(
        lease,
        workflow.id,
        null,
        "worker",
        FAST_WORKER_PROFILE,
        journal,
      );
    this.commitCheckpoint(repository, lease, run.id, "workflow.accepted");
    this.commitCheckpoint(repository, lease, run.id, "worker.dispatched");
    return this.prepareRun(workflow, run, journal, lease);
  }

  private ensureWorkerRun(
    workflow: StoredWorkflow,
    parentRunId: string,
    profile: ModelProfile,
    objective: string,
    completionCriteria: string[],
    repository: CheckpointRepository,
    lease: WorkflowLease,
  ): PreparedRun {
    const journal = createAgentJournal({
      directory: join(workflow.taskDir, "workers", "worker-1"),
      role: "worker",
      workflowId: workflow.id,
      workspace: workflow.workspace,
      objective,
      completionCriteria,
    });
    const existing = this.store
      .listStoredAgentRuns(workflow.id)
      .find((run) => run.role === "worker");
    const run =
      existing ??
      this.createRun(
        lease,
        workflow.id,
        parentRunId,
        "worker",
        profile,
        journal,
      );
    if (run.profile !== profile) {
      throw new Error("Persisted Worker route differs from the Orchestrator plan");
    }
    this.commitCheckpoint(repository, lease, run.id, "worker.dispatched");
    return this.prepareRun(workflow, run, journal, lease);
  }

  private ensureVerifierRun(
    workflow: StoredWorkflow,
    parentRunId: string,
    profile: ModelProfile,
    completionCriteria: string[],
    repository: CheckpointRepository,
    lease: WorkflowLease,
  ): PreparedRun {
    const journal = createAgentJournal({
      directory: join(workflow.taskDir, "verifier"),
      role: "verifier",
      workflowId: workflow.id,
      workspace: workflow.workspace,
      objective:
        "Independently verify the Worker result against the original workflow request.",
      completionCriteria: [
        ...completionCriteria,
        "Report only evidence-backed material findings.",
        "Do not modify the implementation under verification.",
      ],
    });
    const existing = this.store
      .listStoredAgentRuns(workflow.id)
      .find((run) => run.role === "verifier");
    const run =
      existing ??
      this.createRun(
        lease,
        workflow.id,
        parentRunId,
        "verifier",
        profile,
        journal,
      );
    if (run.profile !== profile) {
      throw new Error("Persisted Verifier route differs from the selected route");
    }
    this.commitCheckpoint(repository, lease, run.id, "verifier.dispatched");
    return this.prepareRun(workflow, run, journal, lease);
  }

  private createRun(
    lease: WorkflowLease,
    workflowId: string,
    parentRunId: string | null,
    role: "orchestrator" | "worker" | "verifier",
    profile: ModelProfile,
    journal: AgentJournalPaths,
  ): StoredAgentRun {
    const id = randomUUID();
    const configured = this.runner.configuration?.(profile) ?? {
      model: modelProfiles[profile].model,
      reasoningEffort: modelProfiles[profile].reasoningEffort,
      requestedServiceTier: DEFAULT_BACKEND_SERVICE_TIER,
    };
    this.store.createAgentRun(lease, {
      id,
      workflowId,
      parentRunId,
      role,
      profile,
      taskDir: journal.directory,
      model: configured.model,
      reasoningEffort: configured.reasoningEffort,
      requestedServiceTier: configured.requestedServiceTier,
    });
    return this.requireRun(id);
  }

  private prepareRun(
    workflow: StoredWorkflow,
    run: StoredAgentRun,
    journal: AgentJournalPaths,
    lease: WorkflowLease,
  ): PreparedRun {
    const codexHome = join(this.codexHomesDir, workflow.id, run.id);
    const metadataPath = join(
      codexHome,
      `workflow-hook.lease-${lease.epoch}.json`,
    );
    const metadata: LifecycleHookMetadata = {
      workflow_id: workflow.id,
      run_id: run.id,
      task_path: journal.task,
      journal_path: journal.journal,
      state_database: this.stateDatabase,
      checkpoint_work_tree: workflow.taskDir,
      checkpoint_git_dir: join(this.checkpointsDir, `${workflow.id}.git`),
      lease_owner: lease.owner,
      lease_epoch: lease.epoch,
      lease_claimed_at: lease.claimedAt,
      git_path: this.gitPath,
    };
    writeLifecycleHookMetadata(metadataPath, metadata);
    prepareAgentCodexHome({
      codexHome,
      ...(process.env.CODEX_HOME
        ? { parentCodexHome: process.env.CODEX_HOME }
        : {}),
      metadataPath,
    });
    return { run: this.requireRun(run.id), journal, codexHome };
  }

  private async executeAgentTurn<T>(
    lease: WorkflowLease,
    prepared: PreparedRun,
    prompt: string,
    schema: z.ZodType<T>,
    outputSchema: z.ZodType<unknown>,
    signal?: AbortSignal,
    progressEvent?: string,
  ): Promise<AgentTurnResult<T>> {
    this.store.assertWorkflowLease(lease);
    if (signal?.aborted) {
      if (signal.reason instanceof WorkflowLeaseLostError) {
        throw signal.reason;
      }
      throw new Error("Workflow execution was cancelled");
    }
    prepareResultForTurn(prepared.journal.result);
    if (progressEvent !== undefined) {
      this.store.appendEvent(
        lease,
        prepared.run.id,
        progressEvent,
        {},
      );
    }
    const request = {
      role: prepared.run.role,
      profile: prepared.run.profile,
      workspace: this.requireWorkflow(prepared.run.workflowId).workspace,
      taskDir: prepared.journal.directory,
      codexHome: prepared.codexHome,
      executionLease: {
        owner: lease.owner,
        epoch: lease.epoch,
        claimedAt: lease.claimedAt,
      },
      prompt,
      outputSchema,
      schema,
      onThreadStarted: (threadId: string) => {
        this.store.setAgentThread(lease, prepared.run.id, threadId);
      },
      ...(signal ? { signal } : {}),
    };
    const result = prepared.run.threadId === null
      ? (await this.runner.start(request)) as AgentTurnResult<T>
      : (await this.runner.continue({
          ...request,
          threadId: prepared.run.threadId,
        })) as AgentTurnResult<T>;
    // A runner may ignore or race the abort signal. Fence the completed turn
    // before its caller can materialize artifacts or advance the route. The
    // event loop may delay an interval heartbeat during a long SDK operation;
    // renew here if and only if this owner/epoch still holds the workflow.
    if (!this.store.heartbeatWorkflow(lease, this.leaseMs)) {
      throw new WorkflowLeaseLostError(lease.workflowId);
    }
    this.store.assertWorkflowLease(lease);
    if (signal?.aborted) {
      if (signal.reason instanceof WorkflowLeaseLostError) {
        throw signal.reason;
      }
      throw new Error("Workflow execution was cancelled");
    }
    const persisted = this.requireRun(prepared.run.id);
    if (persisted.threadId === null) {
      this.store.setAgentThread(
        lease,
        prepared.run.id,
        result.threadId,
        true,
      );
    }
    return result;
  }

  private completedOutcome<T>(
    workflowId: string,
    eventType: string,
    schema: { parse(value: unknown): T },
  ): T | null {
    const event = this.store.latestEvent<AgentCompletionPayload<unknown>>(
      workflowId,
      eventType,
    );
    return event === undefined ? null : schema.parse(event.payload.outcome);
  }

  private finishRunIfRunning(lease: WorkflowLease, runId: string): void {
    const run = this.requireRun(runId);
    if (run.status !== "running") {
      return;
    }
    this.store.finishAgentRun(
      lease,
      run.id,
      "completed",
      run.usage,
      run.usageStatus,
    );
  }

  private currentUsage(workflowId: string): UsageSummary {
    return aggregateUsage(this.store.listStoredAgentRuns(workflowId));
  }

  private fastTerminalOutcome(
    worker: FastWorkerOutcome,
    verifier: VerificationOutcome,
    verifierJournal: AgentJournalPaths,
  ): AgentOutcome {
    switch (verifier.status) {
      case "passed":
        return {
          status: "completed",
          summary: `${worker.summary} ${verifier.summary}`,
          result_path: verifierJournal.result,
          questions: [],
          blocker: null,
        };
      case "findings":
        return {
          status: "failed",
          summary: verifier.summary,
          result_path: verifierJournal.result,
          questions: [],
          blocker:
            verifier.findings.map((finding) => finding.issue).join("; ") ||
            "Independent verification found a material issue",
        };
      case "needs_input":
        return {
          status: "needs_input",
          summary: verifier.summary,
          result_path: verifierJournal.result,
          questions: verifier.questions,
          blocker: verifier.blocker,
        };
      case "blocked":
        return {
          status: "blocked",
          summary: verifier.summary,
          result_path: verifierJournal.result,
          questions: verifier.questions,
          blocker: verifier.blocker,
        };
    }
  }

  private verificationTerminalOutcome(
    verifier: Exclude<VerificationOutcome, { status: "passed" }>,
    verifierJournal: AgentJournalPaths,
  ): AgentOutcome {
    switch (verifier.status) {
      case "findings":
        return {
          status: "failed",
          summary: verifier.summary,
          result_path: verifierJournal.result,
          questions: [],
          blocker:
            verifier.findings.map((finding) => finding.issue).join("; ") ||
            "Independent verification found a material issue",
        };
      case "needs_input":
        return {
          status: "needs_input",
          summary: verifier.summary,
          result_path: verifierJournal.result,
          questions: verifier.questions,
          blocker: null,
        };
      case "blocked":
        return {
          status: "blocked",
          summary: verifier.summary,
          result_path: verifierJournal.result,
          questions: [],
          blocker: verifier.blocker,
        };
    }
  }

  private failWorkflow(
    lease: WorkflowLease,
    taskDir: string,
    executionRoute: ExecutionRoute,
    message: string,
  ): WorkflowRunOutput {
    const workflowId = lease.workflowId;
    const terminal = this.store.terminalOutput(workflowId);
    if (terminal !== null) {
      return terminal;
    }
    const runs = this.store.listStoredAgentRuns(workflowId);
    const running = runs.filter((run) => run.status === "running");
    const current = running.at(-1);
    const resultPath =
      current === undefined
        ? null
        : join(current.taskDir, "result.md");
    if (current !== undefined && resultPath !== null) {
      ensureFailureResult(resultPath, message);
      freezeResult(resultPath);
    }
    const failureKind = classifyFailure(message);
    for (const run of running) {
      this.store.finishAgentRun(
        lease,
        run.id,
        "failed",
        run.usage,
        failedUsageStatus(run),
        message,
        failureKind,
      );
    }
    this.store.appendEvent(lease, null, "workflow.execution_failed", {
      error: message,
      failure_kind: failureKind,
      recovery_requires_user_approval: failureKind === "cyber_policy",
    });
    return this.finishWorkflow(
      lease,
      taskDir,
      {
        status: "failed",
        summary: message,
        result_path: resultPath,
        questions: [],
        blocker: message,
      },
      this.currentUsage(workflowId),
      executionRoute,
      null,
      failureKind,
    );
  }

  private cancelWorkflow(
    lease: WorkflowLease,
    taskDir: string,
    executionRoute: ExecutionRoute,
    message: string,
  ): WorkflowRunOutput {
    const terminal = this.store.terminalOutput(lease.workflowId);
    if (terminal !== null) {
      return terminal;
    }
    const runs = this.store.listStoredAgentRuns(lease.workflowId);
    const running = runs.filter((run) => run.status === "running");
    const current = running.at(-1);
    const resultPath =
      current === undefined ? null : join(current.taskDir, "result.md");
    if (current !== undefined && resultPath !== null) {
      ensureResult(resultPath, current.role, {
        status: "cancelled",
        summary: message,
        questions: [],
        blocker: message,
      });
      freezeResult(resultPath);
    }
    for (const run of running) {
      this.store.finishAgentRun(
        lease,
        run.id,
        "cancelled",
        run.usage,
        failedUsageStatus(run),
        message,
        "cancelled",
      );
    }
    this.store.appendEvent(lease, null, "workflow.cancelled", {
      reason: message,
    });
    return this.finishWorkflow(
      lease,
      taskDir,
      {
        status: "cancelled",
        summary: message,
        result_path: resultPath,
        questions: [],
        blocker: message,
      },
      this.currentUsage(lease.workflowId),
      executionRoute,
    );
  }

  private finishWorkflow(
    lease: WorkflowLease,
    workflowTaskDir: string,
    outcome: TerminalOutcome,
    usage: UsageSummary,
    executionRoute: ExecutionRoute = "orchestrated",
    retryRoute: "orchestrated" | null = null,
    failureKind: WorkflowFailureKind = null,
  ): WorkflowRunOutput {
    const output = workflowRunOutputSchema.parse({
      workflow_id: lease.workflowId,
      status: outcome.status,
      summary: outcome.summary,
      task_dir: workflowTaskDir,
      result_path: outcome.result_path,
      questions: outcome.questions,
      blocker: outcome.blocker,
      usage: usage.status === "unknown" ? null : usage.usage,
      usage_status: usage.status,
      execution_route: executionRoute,
      retry_route: retryRoute,
      failure_kind: failureKind,
      recovery_requires_user_approval: failureKind === "cyber_policy",
    });
    this.store.finishWorkflow(lease, output);
    return output;
  }

  private commitCheckpoint(
    repository: CheckpointRepository,
    lease: WorkflowLease,
    runId: string | null,
    kind: string,
  ): void {
    const workflowId = lease.workflowId;
    this.store.assertWorkflowLease(lease);
    if (this.store.hasCheckpoint(workflowId, kind)) {
      return;
    }
    const committed = repository.findCommit(kind, lease.epoch);
    if (
      committed !== null &&
      !this.store.hasCheckpointCommit(workflowId, committed.id)
    ) {
      this.store.recordCheckpoint(
        lease,
        runId,
        committed.kind,
        committed.id,
        "checkpoint.recovered",
      );
      return;
    }
    const checkpoint = repository.commit(kind, { leaseEpoch: lease.epoch });
    this.store.recordCheckpoint(
      lease,
      runId,
      checkpoint.kind,
      checkpoint.id,
    );
  }

  private checkpointRepository(
    workflowId: string,
    taskDir: string,
  ): CheckpointRepository {
    return new CheckpointRepository({
      workTree: taskDir,
      gitDir: join(this.checkpointsDir, `${workflowId}.git`),
      gitPath: this.gitPath,
    });
  }

  private restoreResumableArtifacts(
    workflow: StoredWorkflow,
    repository: CheckpointRepository,
    lease: WorkflowLease,
  ): void {
    const checkpoints = [...this.store.listStoredCheckpoints(workflow.id)].reverse();
    const resumableRuns = this.store
      .listStoredAgentRuns(workflow.id)
      .filter((run) => run.status === "running" && run.threadId !== null);

    for (const run of resumableRuns) {
      const journal: AgentJournalPaths = {
        directory: run.taskDir,
        task: join(run.taskDir, "task.md"),
        journal: join(run.taskDir, "journal.md"),
        result: join(run.taskDir, "result.md"),
      };
      const taskPath = relative(repository.workTree, journal.task);
      const journalPath = relative(repository.workTree, journal.journal);
      const checkpoint = checkpoints.find(
        (item) =>
          repository.hasFileAt(item.commitId, taskPath) &&
          repository.hasFileAt(item.commitId, journalPath),
      );
      if (checkpoint === undefined) {
        throw new Error(
          `Cannot recover ${run.role} run ${run.id}: no authoritative complete Checkpoint contains ${taskPath} and ${journalPath}`,
        );
      }
      const task = repository.readFileAt(checkpoint.commitId, taskPath);
      const narrative = repository.readFileAt(checkpoint.commitId, journalPath);
      if (task.trim() === "" || narrative.trim() === "") {
        throw new Error(
          `Cannot recover ${run.role} run ${run.id}: Checkpoint ${checkpoint.commitId} contains an empty Task or Journal`,
        );
      }
      restoreAgentJournal(journal, task, narrative);
      this.store.appendEvent(lease, run.id, "journal.restored", {
        checkpoint_kind: checkpoint.kind,
        commit_id: checkpoint.commitId,
        task_path: journal.task,
        journal_path: journal.journal,
      });
    }
  }

  private assertWorkflowIdentity(
    workflow: StoredWorkflow,
    input: ParsedWorkflowRunInput,
    workspace: string,
  ): void {
    if (
      workflow.request !== input.request ||
      workflow.workspace !== workspace ||
      workflow.executionRoute !== input.execution_route ||
      JSON.stringify(workflow.completionCriteria) !==
        JSON.stringify(input.completion_criteria)
    ) {
      throw new Error(
        `Workflow ${workflow.id} cannot be reused with different request, workspace, route, or completion criteria`,
      );
    }
  }

  private requireWorkflow(id: string): StoredWorkflow {
    const workflow = this.store.getStoredWorkflow(id);
    if (workflow === undefined) {
      throw new Error(`Unknown workflow: ${id}`);
    }
    return workflow;
  }

  private requireRun(id: string): StoredAgentRun {
    const run = this.store.getStoredAgentRun(id);
    if (run === undefined) {
      throw new Error(`Unknown agent run: ${id}`);
    }
    return run;
  }
}
