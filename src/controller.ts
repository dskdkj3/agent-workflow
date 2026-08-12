import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

import type { AgentRunner, AgentTurnResult } from "./agent-runner.js";
import { CheckpointRepository } from "./checkpoints.js";
import { prepareAgentCodexHome } from "./codex-home.js";
import {
  addUsage,
  agentOutcomeSchema,
  emptyUsage,
  fastWorkerOutcomeSchema,
  orchestrationPlanSchema,
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

const ORCHESTRATOR_PROFILE: ModelProfile = "sol_high";
const FAST_WORKER_PROFILE: ModelProfile = "luna_max";
const FAST_VERIFIER_PROFILE: ModelProfile = "luna_max";
const DEFAULT_LEASE_MS = 30_000;

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

    const owner = randomUUID();
    if (!this.store.claimWorkflow(workflowId, owner, this.leaseMs)) {
      throw new Error(
        `Workflow ${workflowId} is already being executed by another Controller`,
      );
    }
    let heartbeat: NodeJS.Timeout | null = null;
    let interrupted = false;
    try {
      heartbeat = setInterval(() => {
        this.store.heartbeatWorkflow(workflowId, owner, this.leaseMs);
      }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
      heartbeat.unref();

      if (created) {
        this.store.appendEvent(workflowId, null, "workflow.started", {
          workspace,
          task_dir: taskDir,
          execution_route: input.execution_route,
        });
      } else {
        this.store.appendEvent(workflowId, null, "workflow.resumed", {
          owner,
        });
      }

      const repository = this.checkpointRepository(workflowId, taskDir);
      return input.execution_route === "single_worker"
        ? await this.runSingleWorker(
            workflow,
            input,
            repository,
            signal,
          )
        : await this.runOrchestrated(
            workflow,
            input,
            repository,
            signal,
          );
    } catch (error) {
      if (error instanceof WorkflowInterruptedError) {
        interrupted = true;
        throw error;
      }
      if (signal?.aborted) {
        return this.failWorkflow(
          workflowId,
          taskDir,
          input.execution_route,
          "Workflow execution was cancelled",
        );
      }
      return this.failWorkflow(
        workflowId,
        taskDir,
        input.execution_route,
        errorMessage(error),
      );
    } finally {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
      }
      if (!interrupted) {
        this.store.releaseWorkflow(workflowId, owner);
      }
    }
  }

  private async runOrchestrated(
    workflow: StoredWorkflow,
    input: ParsedWorkflowRunInput,
    repository: CheckpointRepository,
    signal?: AbortSignal,
  ): Promise<WorkflowRunOutput> {
    const orchestrator = this.ensureOrchestratorRun(workflow, repository);
    let plan = this.completedOutcome<OrchestrationPlan>(
      workflow.id,
      "orchestrator.planned",
      orchestrationPlanSchema,
    );
    if (plan === null) {
      const turn = await this.executeAgentTurn(
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
        signal,
      );
      plan = turn.output;
      const usage = addUsage(orchestrator.run.usage, turn.usage);
      this.store.recordAgentProgress(
        orchestrator.run.id,
        usage,
        "orchestrator.planned",
        {
          thread_id: turn.threadId,
          outcome: plan,
          usage: turn.usage,
        },
      );
    }
    this.commitCheckpoint(
      repository,
      workflow.id,
      orchestrator.run.id,
      "orchestrator.planned",
    );

    if (plan.status !== "ready") {
      const outcome = normalizedOutcome(
        {
          status: plan.status,
          summary: plan.summary,
          result_path: orchestrator.journal.result,
          questions: plan.questions,
          blocker: plan.blocker,
        },
        orchestrator.journal.result,
      );
      ensureResult(orchestrator.journal.result, "orchestrator", outcome);
      const run = this.requireRun(orchestrator.run.id);
      this.store.finishAgentRun(run.id, "completed", run.usage);
      this.commitCheckpoint(
        repository,
        workflow.id,
        orchestrator.run.id,
        `workflow.${outcome.status}`,
      );
      freezeResult(orchestrator.journal.result);
      return this.finishWorkflow(
        workflow.id,
        workflow.taskDir,
        outcome,
        this.currentUsage(workflow.id),
      );
    }

    if (
      plan.worker_task === null ||
      plan.worker_profile === null ||
      plan.verifier_profile === null
    ) {
      throw new Error("Orchestrator returned an incomplete ready plan");
    }

    const worker = this.ensureWorkerRun(
      workflow,
      orchestrator.run.id,
      plan.worker_profile,
      plan.worker_task,
      plan.completion_criteria,
      repository,
    );
    let workerOutcome = this.completedOutcome<AgentOutcome>(
      workflow.id,
      "worker.completed",
      agentOutcomeSchema,
    );
    if (workerOutcome === null) {
      const turn = await this.executeAgentTurn(
        worker,
        worker.run.threadId === null
          ? workerPrompt({ workspace: workflow.workspace, journal: worker.journal })
          : recoverWorkerPrompt({
              workspace: workflow.workspace,
              journal: worker.journal,
            }),
        agentOutcomeSchema,
        signal,
      );
      workerOutcome = normalizedOutcome(turn.output, worker.journal.result);
      ensureResult(worker.journal.result, "worker", workerOutcome);
      const usage = addUsage(worker.run.usage, turn.usage);
      this.store.completeAgentRun(worker.run.id, usage, "worker.completed", {
        thread_id: turn.threadId,
        outcome: workerOutcome,
        usage: turn.usage,
      });
    }
    this.commitCheckpoint(
      repository,
      workflow.id,
      worker.run.id,
      "worker.completed",
    );
    freezeResult(worker.journal.result);

    let verifier: PreparedRun | null = null;
    let verifierOutcome: VerificationOutcome | null = null;
    if (workerOutcome.status === "completed") {
      verifier = this.ensureVerifierRun(
        workflow,
        orchestrator.run.id,
        plan.verifier_profile,
        plan.completion_criteria,
        repository,
      );
      verifierOutcome = this.completedOutcome<VerificationOutcome>(
        workflow.id,
        "verifier.completed",
        verificationOutcomeSchema,
      );
      if (verifierOutcome === null) {
        const turn = await this.executeAgentTurn(
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
          signal,
        );
        verifierOutcome = normalizedVerificationOutcome(
          turn.output,
          verifier.journal.result,
        );
        ensureVerificationResult(verifier.journal.result, verifierOutcome);
        const usage = addUsage(verifier.run.usage, turn.usage);
        this.store.completeAgentRun(
          verifier.run.id,
          usage,
          "verifier.completed",
          {
            thread_id: turn.threadId,
            outcome: verifierOutcome,
            usage: turn.usage,
          },
        );
      }
      this.commitCheckpoint(
        repository,
        workflow.id,
        verifier.run.id,
        "verifier.completed",
      );
      freezeResult(verifier.journal.result);
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
      ensureResult(orchestrator.journal.result, "orchestrator", finalOutcome);
      const usage = finalTurn.usage ?? latestOrchestrator.usage;
      this.store.completeAgentRun(
        orchestrator.run.id,
        usage,
        "orchestrator.completed",
        {
          thread_id: finalTurn.threadId,
          outcome: finalOutcome,
          usage: finalTurn.usage,
        },
      );
    }
    this.commitCheckpoint(
      repository,
      workflow.id,
      orchestrator.run.id,
      "orchestrator.completed",
    );
    freezeResult(orchestrator.journal.result);

    return this.finishWorkflow(
      workflow.id,
      workflow.taskDir,
      finalOutcome,
      this.currentUsage(workflow.id),
    );
  }

  private async runSingleWorker(
    workflow: StoredWorkflow,
    input: ParsedWorkflowRunInput,
    repository: CheckpointRepository,
    signal?: AbortSignal,
  ): Promise<WorkflowRunOutput> {
    const worker = this.ensureFastWorkerRun(workflow, repository);
    let workerOutcome = this.completedOutcome<FastWorkerOutcome>(
      workflow.id,
      "worker.completed",
      fastWorkerOutcomeSchema,
    );
    if (workerOutcome === null) {
      const turn = await this.executeAgentTurn(
        worker,
        worker.run.threadId === null
          ? fastWorkerPrompt({ workspace: workflow.workspace, journal: worker.journal })
          : recoverFastWorkerPrompt({
              workspace: workflow.workspace,
              journal: worker.journal,
            }),
        fastWorkerOutcomeSchema,
        signal,
      );
      workerOutcome = normalizedFastOutcome(turn.output, worker.journal.result);
      ensureStructuredJournal(worker.journal.journal, workerOutcome);
      ensureResult(worker.journal.result, "worker", workerOutcome);
      const usage = addUsage(worker.run.usage, turn.usage);
      this.store.completeAgentRun(worker.run.id, usage, "worker.completed", {
        thread_id: turn.threadId,
        outcome: workerOutcome,
        usage: turn.usage,
      });
    }
    this.commitCheckpoint(
      repository,
      workflow.id,
      worker.run.id,
      "worker.completed",
    );
    freezeResult(worker.journal.result);

    if (workerOutcome.status !== "completed") {
      const retryRoute =
        workerOutcome.status === "escalate" ? "orchestrated" : null;
      const terminalOutcome: AgentOutcome = {
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
      };
      this.commitCheckpoint(
        repository,
        workflow.id,
        worker.run.id,
        retryRoute === null
          ? `workflow.${terminalOutcome.status}`
          : "workflow.escalated",
      );
      return this.finishWorkflow(
        workflow.id,
        workflow.taskDir,
        terminalOutcome,
        this.currentUsage(workflow.id),
        "single_worker",
        retryRoute,
      );
    }

    const verifier = this.ensureVerifierRun(
      workflow,
      worker.run.id,
      FAST_VERIFIER_PROFILE,
      input.completion_criteria,
      repository,
    );
    let verifierOutcome = this.completedOutcome<VerificationOutcome>(
      workflow.id,
      "verifier.completed",
      verificationOutcomeSchema,
    );
    if (verifierOutcome === null) {
      const turn = await this.executeAgentTurn(
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
        signal,
      );
      verifierOutcome = normalizedVerificationOutcome(
        turn.output,
        verifier.journal.result,
      );
      ensureStructuredJournal(verifier.journal.journal, verifierOutcome);
      ensureVerificationResult(verifier.journal.result, verifierOutcome);
      const usage = addUsage(verifier.run.usage, turn.usage);
      this.store.completeAgentRun(
        verifier.run.id,
        usage,
        "verifier.completed",
        {
          thread_id: turn.threadId,
          outcome: verifierOutcome,
          usage: turn.usage,
        },
      );
    }
    this.commitCheckpoint(
      repository,
      workflow.id,
      verifier.run.id,
      "verifier.completed",
    );
    freezeResult(verifier.journal.result);

    const terminalOutcome = this.fastTerminalOutcome(
      workerOutcome,
      verifierOutcome,
      worker.journal,
      verifier.journal,
    );
    const retryRoute =
      verifierOutcome.status === "findings" ? "orchestrated" : null;
    this.commitCheckpoint(
      repository,
      workflow.id,
      verifier.run.id,
      retryRoute === null
        ? `workflow.${terminalOutcome.status}`
        : "workflow.escalated",
    );
    return this.finishWorkflow(
      workflow.id,
      workflow.taskDir,
      terminalOutcome,
      this.currentUsage(workflow.id),
      "single_worker",
      retryRoute,
    );
  }

  private ensureOrchestratorRun(
    workflow: StoredWorkflow,
    repository: CheckpointRepository,
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
        workflow.id,
        null,
        "orchestrator",
        ORCHESTRATOR_PROFILE,
        journal,
      );
    this.commitCheckpoint(repository, workflow.id, run.id, "workflow.accepted");
    return this.prepareRun(workflow, run, journal);
  }

  private ensureFastWorkerRun(
    workflow: StoredWorkflow,
    repository: CheckpointRepository,
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
        workflow.id,
        null,
        "worker",
        FAST_WORKER_PROFILE,
        journal,
      );
    this.commitCheckpoint(repository, workflow.id, run.id, "workflow.accepted");
    this.commitCheckpoint(repository, workflow.id, run.id, "worker.dispatched");
    return this.prepareRun(workflow, run, journal);
  }

  private ensureWorkerRun(
    workflow: StoredWorkflow,
    parentRunId: string,
    profile: ModelProfile,
    objective: string,
    completionCriteria: string[],
    repository: CheckpointRepository,
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
        workflow.id,
        parentRunId,
        "worker",
        profile,
        journal,
      );
    if (run.profile !== profile) {
      throw new Error("Persisted Worker route differs from the Orchestrator plan");
    }
    this.commitCheckpoint(repository, workflow.id, run.id, "worker.dispatched");
    return this.prepareRun(workflow, run, journal);
  }

  private ensureVerifierRun(
    workflow: StoredWorkflow,
    parentRunId: string,
    profile: ModelProfile,
    completionCriteria: string[],
    repository: CheckpointRepository,
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
        workflow.id,
        parentRunId,
        "verifier",
        profile,
        journal,
      );
    if (run.profile !== profile) {
      throw new Error("Persisted Verifier route differs from the selected route");
    }
    this.commitCheckpoint(repository, workflow.id, run.id, "verifier.dispatched");
    return this.prepareRun(workflow, run, journal);
  }

  private createRun(
    workflowId: string,
    parentRunId: string | null,
    role: "orchestrator" | "worker" | "verifier",
    profile: ModelProfile,
    journal: AgentJournalPaths,
  ): StoredAgentRun {
    const id = randomUUID();
    this.store.createAgentRun({
      id,
      workflowId,
      parentRunId,
      role,
      profile,
      taskDir: journal.directory,
    });
    return this.requireRun(id);
  }

  private prepareRun(
    workflow: StoredWorkflow,
    run: StoredAgentRun,
    journal: AgentJournalPaths,
  ): PreparedRun {
    const codexHome = join(this.codexHomesDir, workflow.id, run.id);
    const metadataPath = join(codexHome, "workflow-hook.json");
    const metadata: LifecycleHookMetadata = {
      workflow_id: workflow.id,
      run_id: run.id,
      task_path: journal.task,
      journal_path: journal.journal,
      state_database: this.stateDatabase,
      checkpoint_work_tree: workflow.taskDir,
      checkpoint_git_dir: join(this.checkpointsDir, `${workflow.id}.git`),
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
    prepared: PreparedRun,
    prompt: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    progressEvent?: string,
  ): Promise<AgentTurnResult<T>> {
    if (progressEvent !== undefined) {
      this.store.appendEvent(
        prepared.run.workflowId,
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
      prompt,
      schema,
      onThreadStarted: (threadId: string) => {
        this.store.setAgentThread(prepared.run.id, threadId);
        this.store.appendEvent(
          prepared.run.workflowId,
          prepared.run.id,
          "agent.thread_started",
          { thread_id: threadId },
        );
      },
      ...(signal ? { signal } : {}),
    };
    const result = prepared.run.threadId === null
      ? (await this.runner.start(request)) as AgentTurnResult<T>
      : (await this.runner.continue({
          ...request,
          threadId: prepared.run.threadId,
        })) as AgentTurnResult<T>;
    const persisted = this.requireRun(prepared.run.id);
    if (persisted.threadId === null) {
      this.store.setAgentThread(prepared.run.id, result.threadId);
      this.store.appendEvent(
        prepared.run.workflowId,
        prepared.run.id,
        "agent.thread_started",
        { thread_id: result.threadId, recovered_from_completed_turn: true },
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

  private currentUsage(workflowId: string): AgentUsage {
    const usage = sumRunUsage(this.store.listStoredAgentRuns(workflowId));
    this.store.updateWorkflowUsage(workflowId, usage);
    return usage;
  }

  private fastTerminalOutcome(
    worker: FastWorkerOutcome,
    verifier: VerificationOutcome,
    workerJournal: AgentJournalPaths,
    verifierJournal: AgentJournalPaths,
  ): AgentOutcome {
    switch (verifier.status) {
      case "passed":
        return {
          status: "completed",
          summary: `${worker.summary} ${verifier.summary}`,
          result_path: workerJournal.result,
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

  private failWorkflow(
    workflowId: string,
    taskDir: string,
    executionRoute: ExecutionRoute,
    message: string,
  ): WorkflowRunOutput {
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
        : createAgentJournal({
            directory: current.taskDir,
            role: current.role,
            workflowId,
            workspace: this.requireWorkflow(workflowId).workspace,
            objective: "Recover workflow execution failure",
            completionCriteria: [],
          }).result;
    if (current !== undefined && resultPath !== null) {
      ensureFailureResult(resultPath, message);
      freezeResult(resultPath);
    }
    for (const run of running) {
      this.store.finishAgentRun(run.id, "failed", run.usage, message);
    }
    this.store.appendEvent(workflowId, null, "workflow.execution_failed", {
      error: message,
    });
    return this.finishWorkflow(
      workflowId,
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
    );
  }

  private finishWorkflow(
    workflowId: string,
    workflowTaskDir: string,
    outcome: AgentOutcome,
    usage: AgentUsage,
    executionRoute: ExecutionRoute = "orchestrated",
    retryRoute: "orchestrated" | null = null,
  ): WorkflowRunOutput {
    const output = workflowRunOutputSchema.parse({
      workflow_id: workflowId,
      status: outcome.status,
      summary: outcome.summary,
      task_dir: workflowTaskDir,
      result_path: outcome.result_path,
      questions: outcome.questions,
      blocker: outcome.blocker,
      usage,
      execution_route: executionRoute,
      retry_route: retryRoute,
    });
    this.store.finishWorkflow(output);
    return output;
  }

  private commitCheckpoint(
    repository: CheckpointRepository,
    workflowId: string,
    runId: string | null,
    kind: string,
  ): void {
    if (this.store.hasCheckpoint(workflowId, kind)) {
      return;
    }
    const committed = repository.findCommit(kind);
    if (
      committed !== null &&
      !this.store.hasCheckpointCommit(workflowId, committed.id)
    ) {
      this.store.recordCheckpoint(
        workflowId,
        runId,
        committed.kind,
        committed.id,
      );
      this.store.appendEvent(workflowId, runId, "checkpoint.recovered", {
        kind: committed.kind,
        commit_id: committed.id,
      });
      return;
    }
    const checkpoint = repository.commit(kind);
    this.store.recordCheckpoint(
      workflowId,
      runId,
      checkpoint.kind,
      checkpoint.id,
    );
    this.store.appendEvent(workflowId, runId, "checkpoint.committed", {
      kind: checkpoint.kind,
      commit_id: checkpoint.id,
    });
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
