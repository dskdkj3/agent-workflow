import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { AgentRunner } from "./agent-runner.js";
import { CheckpointRepository } from "./checkpoints.js";
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
  type ParsedWorkflowRunInput,
  type VerificationOutcome,
  type WorkflowRunInput,
  type WorkflowRunOutput,
} from "./contracts.js";
import {
  createAgentJournal,
  ensureFrozenFailureResult,
  ensureFrozenResult,
  ensureFrozenVerificationResult,
  ensureStructuredJournal,
  type AgentJournalPaths,
} from "./journal.js";
import {
  finalOrchestratorPrompt,
  fastWorkerPrompt,
  initialOrchestratorPrompt,
  verifierPrompt,
  workerPrompt,
} from "./prompts.js";
import { StateStore } from "./state.js";

export interface WorkflowControllerOptions {
  stateDir: string;
  runner: AgentRunner;
  gitPath?: string;
}

const ORCHESTRATOR_PROFILE: ModelProfile = "sol_high";
const FAST_WORKER_PROFILE: ModelProfile = "luna_max";
const FAST_VERIFIER_PROFILE: ModelProfile = "luna_max";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedOutcome(
  outcome: AgentOutcome,
  resultPath: string,
): AgentOutcome {
  return {
    ...outcome,
    result_path: resultPath,
  };
}

function normalizedVerificationOutcome(
  outcome: VerificationOutcome,
  resultPath: string,
): VerificationOutcome {
  return {
    ...outcome,
    result_path: resultPath,
  };
}

function normalizedFastOutcome(
  outcome: FastWorkerOutcome,
  resultPath: string,
): FastWorkerOutcome {
  return {
    ...outcome,
    result_path: resultPath,
  };
}

export class WorkflowController {
  readonly stateDir: string;
  readonly store: StateStore;
  private readonly checkpointsDir: string;
  private readonly gitPath: string;
  private readonly tasksDir: string;
  private readonly runner: AgentRunner;

  constructor(options: WorkflowControllerOptions) {
    this.stateDir = resolve(options.stateDir);
    this.tasksDir = join(this.stateDir, "tasks");
    this.checkpointsDir = join(this.stateDir, "checkpoints");
    this.gitPath = options.gitPath ?? "git";
    mkdirSync(this.tasksDir, { recursive: true });
    mkdirSync(this.checkpointsDir, { recursive: true });
    this.store = new StateStore(join(this.stateDir, "controller.sqlite3"));
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
    if (input.execution_route === "single_worker") {
      return this.runSingleWorker(input, workspace, signal);
    }

    const workflowId = randomUUID();
    const workflowTaskDir = join(this.tasksDir, workflowId);
    const checkpointRepository = new CheckpointRepository({
      workTree: workflowTaskDir,
      gitDir: join(this.checkpointsDir, `${workflowId}.git`),
      gitPath: this.gitPath,
    });
    const orchestratorJournal = createAgentJournal({
      directory: join(workflowTaskDir, "orchestrator"),
      role: "orchestrator",
      workflowId,
      workspace,
      objective: input.request,
      completionCriteria: [
        "Delegate one precise task to one Generic Worker.",
        "Verify the Worker result against the original request.",
        "Produce a final outcome suitable for the Interaction Agent.",
      ],
    });

    let totalUsage = emptyUsage();
    let orchestratorUsage = emptyUsage();
    let workerUsage = emptyUsage();
    this.store.createWorkflow(
      workflowId,
      input.request,
      workspace,
      workflowTaskDir,
      input.execution_route,
      totalUsage,
    );
    this.store.appendEvent(workflowId, null, "workflow.started", {
      workspace,
      task_dir: workflowTaskDir,
      execution_route: input.execution_route,
    });

    const orchestratorRunId = randomUUID();
    this.store.createAgentRun({
      id: orchestratorRunId,
      workflowId,
      parentRunId: null,
      role: "orchestrator",
      profile: ORCHESTRATOR_PROFILE,
      taskDir: orchestratorJournal.directory,
    });

    let orchestratorThreadId: string | null = null;
    let orchestratorFinished = false;
    let workerRunId: string | null = null;
    let workerFinished = false;
    let verifierRunId: string | null = null;
    let verifierFinished = false;
    let verifierUsage = emptyUsage();

    try {
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        orchestratorRunId,
        "workflow.accepted",
      );
      const planTurn = await this.runner.start({
        role: "orchestrator",
        profile: ORCHESTRATOR_PROFILE,
        workspace,
        taskDir: orchestratorJournal.directory,
        prompt: initialOrchestratorPrompt({
          request: input.request,
          workspace,
          journal: orchestratorJournal,
        }),
        schema: orchestrationPlanSchema,
        ...(signal ? { signal } : {}),
      });
      orchestratorThreadId = planTurn.threadId;
      this.store.setAgentThread(orchestratorRunId, orchestratorThreadId);
      orchestratorUsage = addUsage(orchestratorUsage, planTurn.usage);
      totalUsage = addUsage(totalUsage, planTurn.usage);
      this.store.appendEvent(workflowId, orchestratorRunId, "orchestrator.planned", {
        thread_id: orchestratorThreadId,
        outcome: planTurn.output,
        usage: planTurn.usage,
      });
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        orchestratorRunId,
        "orchestrator.planned",
      );

      if (planTurn.output.status !== "ready") {
        const earlyOutcome = normalizedOutcome(
          {
            status: planTurn.output.status,
            summary: planTurn.output.summary,
            result_path: orchestratorJournal.result,
            questions: planTurn.output.questions,
            blocker: planTurn.output.blocker,
          },
          orchestratorJournal.result,
        );
        ensureFrozenResult(
          orchestratorJournal.result,
          "orchestrator",
          earlyOutcome,
        );
        this.store.finishAgentRun(
          orchestratorRunId,
          "completed",
          orchestratorUsage,
        );
        orchestratorFinished = true;
        this.commitCheckpoint(
          checkpointRepository,
          workflowId,
          orchestratorRunId,
          `workflow.${earlyOutcome.status}`,
        );
        return this.finishWorkflow(
          workflowId,
          workflowTaskDir,
          earlyOutcome,
          totalUsage,
        );
      }

      if (planTurn.output.worker_task === null) {
        throw new Error('Orchestrator returned status "ready" without worker_task');
      }
      if (planTurn.output.worker_profile === null) {
        throw new Error(
          'Orchestrator returned status "ready" without worker_profile',
        );
      }
      if (planTurn.output.verifier_profile === null) {
        throw new Error(
          'Orchestrator returned status "ready" without verifier_profile',
        );
      }

      const workerProfile = planTurn.output.worker_profile;
      const verifierProfile = planTurn.output.verifier_profile;

      const workerJournal = createAgentJournal({
        directory: join(workflowTaskDir, "workers", "worker-1"),
        role: "worker",
        workflowId,
        workspace,
        objective: planTurn.output.worker_task,
        completionCriteria: planTurn.output.completion_criteria,
      });
      const currentWorkerRunId = randomUUID();
      workerRunId = currentWorkerRunId;
      this.store.createAgentRun({
        id: currentWorkerRunId,
        workflowId,
        parentRunId: orchestratorRunId,
        role: "worker",
        profile: workerProfile,
        taskDir: workerJournal.directory,
      });
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        currentWorkerRunId,
        "worker.dispatched",
      );

      const workerTurn = await this.runner.start({
        role: "worker",
        profile: workerProfile,
        workspace,
        taskDir: workerJournal.directory,
        prompt: workerPrompt({ workspace, journal: workerJournal }),
        schema: agentOutcomeSchema,
        ...(signal ? { signal } : {}),
      });
      this.store.setAgentThread(currentWorkerRunId, workerTurn.threadId);
      workerUsage = addUsage(workerUsage, workerTurn.usage);
      totalUsage = addUsage(totalUsage, workerTurn.usage);
      const workerOutcome = normalizedOutcome(
        workerTurn.output,
        workerJournal.result,
      );
      ensureFrozenResult(workerJournal.result, "worker", workerOutcome);
      this.store.finishAgentRun(currentWorkerRunId, "completed", workerUsage);
      workerFinished = true;
      this.store.appendEvent(workflowId, currentWorkerRunId, "worker.completed", {
        thread_id: workerTurn.threadId,
        outcome: workerOutcome,
        usage: workerTurn.usage,
      });
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        currentWorkerRunId,
        "worker.completed",
      );

      let verifierJournal: AgentJournalPaths | null = null;
      let verifierOutcome: VerificationOutcome | null = null;
      if (workerOutcome.status === "completed") {
        verifierJournal = createAgentJournal({
          directory: join(workflowTaskDir, "verifier"),
          role: "verifier",
          workflowId,
          workspace,
          objective:
            "Independently verify the Worker result against the original workflow request.",
          completionCriteria: [
            ...planTurn.output.completion_criteria,
            "Report only evidence-backed material findings.",
            "Do not modify the implementation under verification.",
          ],
        });
        const currentVerifierRunId = randomUUID();
        verifierRunId = currentVerifierRunId;
        this.store.createAgentRun({
          id: currentVerifierRunId,
          workflowId,
          parentRunId: orchestratorRunId,
          role: "verifier",
          profile: verifierProfile,
          taskDir: verifierJournal.directory,
        });
        this.commitCheckpoint(
          checkpointRepository,
          workflowId,
          currentVerifierRunId,
          "verifier.dispatched",
        );

        const verifierTurn = await this.runner.start({
          role: "verifier",
          profile: verifierProfile,
          workspace,
          taskDir: verifierJournal.directory,
          prompt: verifierPrompt({
            request: input.request,
            workspace,
            journal: verifierJournal,
            workerJournal,
            completionCriteria: planTurn.output.completion_criteria,
          }),
          schema: verificationOutcomeSchema,
          ...(signal ? { signal } : {}),
        });
        this.store.setAgentThread(currentVerifierRunId, verifierTurn.threadId);
        verifierUsage = addUsage(verifierUsage, verifierTurn.usage);
        totalUsage = addUsage(totalUsage, verifierTurn.usage);
        verifierOutcome = normalizedVerificationOutcome(
          verifierTurn.output,
          verifierJournal.result,
        );
        ensureFrozenVerificationResult(
          verifierJournal.result,
          verifierOutcome,
        );
        this.store.finishAgentRun(
          currentVerifierRunId,
          "completed",
          verifierUsage,
        );
        verifierFinished = true;
        this.store.appendEvent(
          workflowId,
          currentVerifierRunId,
          "verifier.completed",
          {
            thread_id: verifierTurn.threadId,
            outcome: verifierOutcome,
            usage: verifierTurn.usage,
          },
        );
        this.commitCheckpoint(
          checkpointRepository,
          workflowId,
          currentVerifierRunId,
          "verifier.completed",
        );
      }

      const finalTurn = await this.runner.continue({
        role: "orchestrator",
        profile: ORCHESTRATOR_PROFILE,
        threadId: orchestratorThreadId,
        workspace,
        taskDir: orchestratorJournal.directory,
        prompt: finalOrchestratorPrompt({
          workspace,
          orchestratorJournal,
          workerJournal,
          workerOutcomeJson: JSON.stringify(workerOutcome, null, 2),
          verifierJournal,
          verifierOutcomeJson:
            verifierOutcome === null
              ? null
              : JSON.stringify(verifierOutcome, null, 2),
        }),
        schema: agentOutcomeSchema,
        ...(signal ? { signal } : {}),
      });
      if (finalTurn.threadId !== orchestratorThreadId) {
        throw new Error(
          `Codex resumed Orchestrator as a different thread: ${finalTurn.threadId}`,
        );
      }
      // Codex SDK 0.147 reports the latest cumulative usage snapshot when a
      // persisted thread is resumed. Replace the earlier Orchestrator snapshot
      // instead of counting its planning turn twice.
      orchestratorUsage = finalTurn.usage ?? orchestratorUsage;
      totalUsage = addUsage(
        addUsage(orchestratorUsage, workerUsage),
        verifierUsage,
      );
      const finalOutcome = normalizedOutcome(
        finalTurn.output,
        orchestratorJournal.result,
      );
      ensureFrozenResult(
        orchestratorJournal.result,
        "orchestrator",
        finalOutcome,
      );
      this.store.finishAgentRun(
        orchestratorRunId,
        "completed",
        orchestratorUsage,
      );
      orchestratorFinished = true;
      this.store.appendEvent(
        workflowId,
        orchestratorRunId,
        "orchestrator.completed",
        {
          thread_id: orchestratorThreadId,
          outcome: finalOutcome,
          usage: finalTurn.usage,
        },
      );
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        orchestratorRunId,
        "orchestrator.completed",
      );

      return this.finishWorkflow(
        workflowId,
        workflowTaskDir,
        finalOutcome,
        totalUsage,
      );
    } catch (error) {
      const message = signal?.aborted
        ? "Workflow execution was cancelled"
        : errorMessage(error);
      if (workerRunId !== null && !workerFinished) {
        this.store.finishAgentRun(workerRunId, "failed", workerUsage, message);
      }
      if (verifierRunId !== null && !verifierFinished) {
        this.store.finishAgentRun(
          verifierRunId,
          "failed",
          verifierUsage,
          message,
        );
      }
      if (!orchestratorFinished) {
        this.store.finishAgentRun(
          orchestratorRunId,
          "failed",
          orchestratorUsage,
          message,
        );
      }
      ensureFrozenFailureResult(orchestratorJournal.result, message);
      this.store.appendEvent(workflowId, null, "workflow.execution_failed", {
        error: message,
        orchestrator_thread_id: orchestratorThreadId,
      });
      try {
        this.commitCheckpoint(
          checkpointRepository,
          workflowId,
          null,
          "workflow.failed",
        );
      } catch (checkpointError) {
        this.store.appendEvent(workflowId, null, "checkpoint.failed", {
          error: errorMessage(checkpointError),
        });
      }

      return this.finishWorkflow(
        workflowId,
        workflowTaskDir,
        {
          status: "failed",
          summary: message,
          result_path: orchestratorJournal.result,
          questions: [],
          blocker: message,
        },
        totalUsage,
      );
    }
  }

  private async runSingleWorker(
    input: ParsedWorkflowRunInput,
    workspace: string,
    signal?: AbortSignal,
  ): Promise<WorkflowRunOutput> {
    const workflowId = randomUUID();
    const workflowTaskDir = join(this.tasksDir, workflowId);
    const checkpointRepository = new CheckpointRepository({
      workTree: workflowTaskDir,
      gitDir: join(this.checkpointsDir, `${workflowId}.git`),
      gitPath: this.gitPath,
    });
    const workerJournal = createAgentJournal({
      directory: join(workflowTaskDir, "workers", "worker-1"),
      role: "worker",
      workflowId,
      workspace,
      objective: input.request,
      completionCriteria: input.completion_criteria,
    });

    let totalUsage = emptyUsage();
    let workerUsage = emptyUsage();
    let verifierUsage = emptyUsage();
    this.store.createWorkflow(
      workflowId,
      input.request,
      workspace,
      workflowTaskDir,
      input.execution_route,
      totalUsage,
    );
    this.store.appendEvent(workflowId, null, "workflow.started", {
      workspace,
      task_dir: workflowTaskDir,
      execution_route: input.execution_route,
    });

    const workerRunId = randomUUID();
    this.store.createAgentRun({
      id: workerRunId,
      workflowId,
      parentRunId: null,
      role: "worker",
      profile: FAST_WORKER_PROFILE,
      taskDir: workerJournal.directory,
    });

    let workerFinished = false;
    let verifierFinished = false;
    let verifierRunId: string | null = null;
    let verifierJournal: AgentJournalPaths | null = null;

    try {
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        workerRunId,
        "workflow.accepted",
      );
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        workerRunId,
        "worker.dispatched",
      );
      const workerTurn = await this.runner.start({
        role: "worker",
        profile: FAST_WORKER_PROFILE,
        workspace,
        taskDir: workerJournal.directory,
        prompt: fastWorkerPrompt({ workspace, journal: workerJournal }),
        schema: fastWorkerOutcomeSchema,
        ...(signal ? { signal } : {}),
      });
      this.store.setAgentThread(workerRunId, workerTurn.threadId);
      workerUsage = addUsage(workerUsage, workerTurn.usage);
      totalUsage = addUsage(totalUsage, workerTurn.usage);
      const workerOutcome = normalizedFastOutcome(
        workerTurn.output,
        workerJournal.result,
      );
      ensureStructuredJournal(workerJournal.journal, workerOutcome);
      ensureFrozenResult(workerJournal.result, "worker", workerOutcome);
      this.store.finishAgentRun(workerRunId, "completed", workerUsage);
      workerFinished = true;
      this.store.appendEvent(workflowId, workerRunId, "worker.completed", {
        thread_id: workerTurn.threadId,
        outcome: workerOutcome,
        usage: workerTurn.usage,
      });
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        workerRunId,
        "worker.completed",
      );

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
          result_path: workerJournal.result,
          questions: workerOutcome.questions,
          blocker:
            workerOutcome.status === "escalate"
              ? "route_escalation_required"
              : workerOutcome.blocker,
        };
        this.commitCheckpoint(
          checkpointRepository,
          workflowId,
          workerRunId,
          workerOutcome.status === "escalate"
            ? "workflow.escalated"
            : `workflow.${terminalOutcome.status}`,
        );
        return this.finishWorkflow(
          workflowId,
          workflowTaskDir,
          terminalOutcome,
          totalUsage,
          "single_worker",
          retryRoute,
        );
      }

      verifierJournal = createAgentJournal({
        directory: join(workflowTaskDir, "verifier"),
        role: "verifier",
        workflowId,
        workspace,
        objective:
          "Independently verify the single-Worker result against the original request.",
        completionCriteria: [
          ...input.completion_criteria,
          "Report only evidence-backed material findings.",
          "Do not modify the implementation under verification.",
        ],
      });
      const currentVerifierRunId = randomUUID();
      verifierRunId = currentVerifierRunId;
      this.store.createAgentRun({
        id: currentVerifierRunId,
        workflowId,
        parentRunId: workerRunId,
        role: "verifier",
        profile: FAST_VERIFIER_PROFILE,
        taskDir: verifierJournal.directory,
      });
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        currentVerifierRunId,
        "verifier.dispatched",
      );

      const verifierTurn = await this.runner.start({
        role: "verifier",
        profile: FAST_VERIFIER_PROFILE,
        workspace,
        taskDir: verifierJournal.directory,
        prompt: verifierPrompt({
          request: input.request,
          workspace,
          journal: verifierJournal,
          workerJournal,
          completionCriteria: input.completion_criteria,
          compactArtifacts: true,
        }),
        schema: verificationOutcomeSchema,
        ...(signal ? { signal } : {}),
      });
      this.store.setAgentThread(currentVerifierRunId, verifierTurn.threadId);
      verifierUsage = addUsage(verifierUsage, verifierTurn.usage);
      totalUsage = addUsage(totalUsage, verifierTurn.usage);
      const verifierOutcome = normalizedVerificationOutcome(
        verifierTurn.output,
        verifierJournal.result,
      );
      ensureStructuredJournal(verifierJournal.journal, verifierOutcome);
      ensureFrozenVerificationResult(
        verifierJournal.result,
        verifierOutcome,
      );
      this.store.finishAgentRun(
        currentVerifierRunId,
        "completed",
        verifierUsage,
      );
      verifierFinished = true;
      this.store.appendEvent(
        workflowId,
        currentVerifierRunId,
        "verifier.completed",
        {
          thread_id: verifierTurn.threadId,
          outcome: verifierOutcome,
          usage: verifierTurn.usage,
        },
      );
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        currentVerifierRunId,
        "verifier.completed",
      );

      let terminalOutcome: AgentOutcome;
      switch (verifierOutcome.status) {
        case "passed":
          terminalOutcome = {
            status: "completed",
            summary: `${workerOutcome.summary} ${verifierOutcome.summary}`,
            result_path: workerJournal.result,
            questions: [],
            blocker: null,
          };
          break;
        case "findings":
          terminalOutcome = {
            status: "failed",
            summary: verifierOutcome.summary,
            result_path: verifierJournal.result,
            questions: [],
            blocker:
              verifierOutcome.findings.map((finding) => finding.issue).join("; ") ||
              "Independent verification found a material issue",
          };
          break;
        case "needs_input":
          terminalOutcome = {
            status: "needs_input",
            summary: verifierOutcome.summary,
            result_path: verifierJournal.result,
            questions: verifierOutcome.questions,
            blocker: verifierOutcome.blocker,
          };
          break;
        case "blocked":
          terminalOutcome = {
            status: "blocked",
            summary: verifierOutcome.summary,
            result_path: verifierJournal.result,
            questions: verifierOutcome.questions,
            blocker: verifierOutcome.blocker,
          };
          break;
      }

      const retryRoute =
        verifierOutcome.status === "findings" ? "orchestrated" : null;
      this.commitCheckpoint(
        checkpointRepository,
        workflowId,
        currentVerifierRunId,
        retryRoute === null
          ? `workflow.${terminalOutcome.status}`
          : "workflow.escalated",
      );
      return this.finishWorkflow(
        workflowId,
        workflowTaskDir,
        terminalOutcome,
        totalUsage,
        "single_worker",
        retryRoute,
      );
    } catch (error) {
      const message = signal?.aborted
        ? "Workflow execution was cancelled"
        : errorMessage(error);
      if (!workerFinished) {
        this.store.finishAgentRun(workerRunId, "failed", workerUsage, message);
      }
      if (verifierRunId !== null && !verifierFinished) {
        this.store.finishAgentRun(
          verifierRunId,
          "failed",
          verifierUsage,
          message,
        );
      }
      const resultPath = verifierJournal?.result ?? workerJournal.result;
      ensureStructuredJournal(
        verifierJournal?.journal ?? workerJournal.journal,
        {
          status: "failed",
          summary: message,
          questions: [],
          blocker: message,
        },
      );
      ensureFrozenFailureResult(resultPath, message);
      this.store.appendEvent(workflowId, null, "workflow.execution_failed", {
        error: message,
        execution_route: "single_worker",
      });
      try {
        this.commitCheckpoint(
          checkpointRepository,
          workflowId,
          null,
          "workflow.failed",
        );
      } catch (checkpointError) {
        this.store.appendEvent(workflowId, null, "checkpoint.failed", {
          error: errorMessage(checkpointError),
        });
      }

      return this.finishWorkflow(
        workflowId,
        workflowTaskDir,
        {
          status: "failed",
          summary: message,
          result_path: resultPath,
          questions: [],
          blocker: message,
        },
        totalUsage,
        "single_worker",
      );
    }
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
}
