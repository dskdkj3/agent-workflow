import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { AgentRunner } from "./agent-runner.js";
import {
  addUsage,
  agentOutcomeSchema,
  emptyUsage,
  orchestrationPlanSchema,
  verificationOutcomeSchema,
  workflowRunInputSchema,
  workflowRunOutputSchema,
  type AgentOutcome,
  type AgentUsage,
  type ModelProfile,
  type VerificationOutcome,
  type WorkflowRunInput,
  type WorkflowRunOutput,
} from "./contracts.js";
import {
  createAgentJournal,
  ensureFrozenFailureResult,
  ensureFrozenResult,
  ensureFrozenVerificationResult,
  type AgentJournalPaths,
} from "./journal.js";
import {
  finalOrchestratorPrompt,
  initialOrchestratorPrompt,
  verifierPrompt,
  workerPrompt,
} from "./prompts.js";
import { StateStore } from "./state.js";

export interface WorkflowControllerOptions {
  stateDir: string;
  runner: AgentRunner;
}

const ORCHESTRATOR_PROFILE: ModelProfile = "sol_high";

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

export class WorkflowController {
  readonly stateDir: string;
  readonly store: StateStore;
  private readonly tasksDir: string;
  private readonly runner: AgentRunner;

  constructor(options: WorkflowControllerOptions) {
    this.stateDir = resolve(options.stateDir);
    this.tasksDir = join(this.stateDir, "tasks");
    mkdirSync(this.tasksDir, { recursive: true });
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

    const workflowId = randomUUID();
    const workflowTaskDir = join(this.tasksDir, workflowId);
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
      totalUsage,
    );
    this.store.appendEvent(workflowId, null, "workflow.started", {
      workspace,
      task_dir: workflowTaskDir,
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
      this.store.appendEvent(workflowId, null, "workflow.failed", {
        error: message,
        orchestrator_thread_id: orchestratorThreadId,
      });

      const output = workflowRunOutputSchema.parse({
        workflow_id: workflowId,
        status: "failed",
        summary: message,
        task_dir: workflowTaskDir,
        result_path: orchestratorJournal.result,
        questions: [],
        blocker: message,
        usage: totalUsage,
      });
      this.store.finishWorkflow(output);
      return output;
    }
  }

  private finishWorkflow(
    workflowId: string,
    workflowTaskDir: string,
    outcome: AgentOutcome,
    usage: AgentUsage,
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
    });
    this.store.finishWorkflow(output);
    this.store.appendEvent(workflowId, null, "workflow.completed", output);
    return output;
  }
}
