import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentRunner,
  AgentTurnRequest,
  AgentTurnResult,
  ContinueAgentTurnRequest,
} from "./agent-runner.js";
import { CheckpointRepository } from "./checkpoints.js";
import {
  emptyUsage,
  type AgentRole,
  type AgentUsage,
  type ModelProfile,
} from "./contracts.js";
import {
  WorkflowController,
  WorkflowInterruptedError,
} from "./controller.js";
import { buildWorkflowTrace } from "./trace.js";

interface FakeStep {
  kind: "start" | "continue";
  threadId?: string;
  output?: unknown;
  usage?: AgentUsage | null;
  error?: Error;
  startedBeforeError?: boolean;
  journal?: string;
  result?: string;
}

type RunnerCall =
  | {
      kind: "start";
      role: AgentRole;
      profile: ModelProfile;
      workspace: string;
      taskDir: string;
      prompt: string;
      journal: string;
    }
  | {
      kind: "continue";
      role: AgentRole;
      profile: ModelProfile;
      threadId: string;
      workspace: string;
      taskDir: string;
      prompt: string;
      journal: string;
    };

class FakeAgentRunner implements AgentRunner {
  readonly calls: RunnerCall[] = [];

  constructor(private readonly steps: FakeStep[]) {}

  async start<T>(
    request: AgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    this.calls.push({
      kind: "start",
      role: request.role,
      profile: request.profile,
      workspace: request.workspace,
      taskDir: request.taskDir,
      prompt: request.prompt,
      journal: readFileSync(join(request.taskDir, "journal.md"), "utf8"),
    });
    return this.take("start", request);
  }

  async continue<T>(
    request: ContinueAgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    this.calls.push({
      kind: "continue",
      role: request.role,
      profile: request.profile,
      threadId: request.threadId,
      workspace: request.workspace,
      taskDir: request.taskDir,
      prompt: request.prompt,
      journal: readFileSync(join(request.taskDir, "journal.md"), "utf8"),
    });
    return this.take("continue", request);
  }

  private take<T>(
    expectedKind: FakeStep["kind"],
    request: AgentTurnRequest<T>,
  ): AgentTurnResult<T> {
    const step = this.steps.shift();
    assert.ok(step, `Missing fake ${expectedKind} step`);
    assert.equal(step.kind, expectedKind);
    if (step.startedBeforeError) {
      assert.ok(step.threadId, `Interrupted ${expectedKind} step needs a thread ID`);
      request.onThreadStarted?.(step.threadId);
    }
    if (step.result !== undefined) {
      writeFileSync(join(request.taskDir, "result.md"), step.result, "utf8");
    }
    if (step.error) {
      throw step.error;
    }
    if (step.journal !== undefined) {
      writeFileSync(join(request.taskDir, "journal.md"), step.journal, "utf8");
    }
    assert.ok(step.threadId, `Fake ${expectedKind} step needs a thread ID`);
    return {
      threadId: step.threadId,
      output: request.schema.parse(step.output),
      usage: step.usage ?? null,
    };
  }
}

class DeferredPlanningRunner implements AgentRunner {
  readonly calls: AgentTurnRequest<unknown>[] = [];
  readonly started: Promise<void>;
  private resolveStarted!: () => void;
  private resolveTurn!: (result: AgentTurnResult<unknown>) => void;
  private readonly turn: Promise<AgentTurnResult<unknown>>;

  constructor() {
    this.started = new Promise((resolvePromise) => {
      this.resolveStarted = resolvePromise;
    });
    this.turn = new Promise((resolvePromise) => {
      this.resolveTurn = resolvePromise;
    });
  }

  async start<T>(request: AgentTurnRequest<T>): Promise<AgentTurnResult<T>> {
    this.calls.push(request as AgentTurnRequest<unknown>);
    await request.onThreadStarted?.("takeover-orchestrator");
    this.resolveStarted();
    return this.turn as Promise<AgentTurnResult<T>>;
  }

  async continue<T>(
    _request: ContinueAgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    throw new Error("The stale Controller must not continue another turn");
  }

  complete(output: unknown, usage: AgentUsage | null): void {
    this.resolveTurn({
      threadId: "takeover-orchestrator",
      output,
      usage,
    });
  }
}

class AbortableRunner implements AgentRunner {
  readonly started: Promise<void>;
  private resolveStarted!: () => void;

  constructor() {
    this.started = new Promise((resolvePromise) => {
      this.resolveStarted = resolvePromise;
    });
  }

  async start<T>(request: AgentTurnRequest<T>): Promise<AgentTurnResult<T>> {
    this.resolveStarted();
    return new Promise((_resolvePromise, rejectPromise) => {
      request.signal?.addEventListener(
        "abort",
        () => rejectPromise(new Error("runner observed cancellation")),
        { once: true },
      );
    });
  }

  async continue<T>(
    _request: ContinueAgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    throw new Error("Unexpected continue after cancellation");
  }
}

class AbortIgnoringWorkerRunner implements AgentRunner {
  readonly calls: AgentRole[] = [];
  readonly workerStarted: Promise<void>;
  private resolveWorkerStarted!: () => void;

  constructor(private readonly includePlanningTurn: boolean) {
    this.workerStarted = new Promise((resolvePromise) => {
      this.resolveWorkerStarted = resolvePromise;
    });
  }

  async start<T>(request: AgentTurnRequest<T>): Promise<AgentTurnResult<T>> {
    this.calls.push(request.role);
    if (this.includePlanningTurn && request.role === "orchestrator") {
      await request.onThreadStarted?.("abort-ignoring-orchestrator");
      return {
        threadId: "abort-ignoring-orchestrator",
        output: request.schema.parse(readyPlan()),
        usage: planUsage,
      };
    }
    await request.onThreadStarted?.("abort-ignoring-worker");
    this.resolveWorkerStarted();
    await new Promise<void>((resolvePromise) => {
      if (request.signal?.aborted) {
        resolvePromise();
        return;
      }
      request.signal?.addEventListener("abort", () => resolvePromise(), {
        once: true,
      });
    });
    return {
      threadId: "abort-ignoring-worker",
      output: request.schema.parse(completedWorker("late success after abort")),
      usage: workerUsage,
    };
  }

  async continue<T>(
    _request: ContinueAgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    throw new Error("Unexpected continue after cancellation");
  }
}

const planUsage: AgentUsage = {
  input_tokens: 10,
  cached_input_tokens: 2,
  cache_write_input_tokens: 1,
  output_tokens: 3,
  reasoning_output_tokens: 4,
};

const workerUsage: AgentUsage = {
  input_tokens: 20,
  cached_input_tokens: 5,
  cache_write_input_tokens: 2,
  output_tokens: 6,
  reasoning_output_tokens: 8,
};

const verifierUsage: AgentUsage = {
  input_tokens: 12,
  cached_input_tokens: 3,
  cache_write_input_tokens: 1,
  output_tokens: 4,
  reasoning_output_tokens: 5,
};

const finalDeltaUsage: AgentUsage = {
  input_tokens: 7,
  cached_input_tokens: 1,
  cache_write_input_tokens: 0,
  output_tokens: 2,
  reasoning_output_tokens: 3,
};

const orchestratorCumulativeUsage = sumUsage(planUsage, finalDeltaUsage);

function sumUsage(...items: AgentUsage[]): AgentUsage {
  return items.reduce<AgentUsage>(
    (total, usage) => ({
      input_tokens: total.input_tokens + usage.input_tokens,
      cached_input_tokens:
        total.cached_input_tokens + usage.cached_input_tokens,
      cache_write_input_tokens:
        total.cache_write_input_tokens + usage.cache_write_input_tokens,
      output_tokens: total.output_tokens + usage.output_tokens,
      reasoning_output_tokens:
        total.reasoning_output_tokens + usage.reasoning_output_tokens,
    }),
    emptyUsage(),
  );
}

function createFixture(): {
  root: string;
  workspace: string;
  stateDir: string;
  evidencePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-controller-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const evidencePath = join(workspace, "verification-evidence.txt");
  writeFileSync(evidencePath, "durable independent fixture evidence\n", "utf8");
  return {
    root,
    workspace,
    stateDir: join(root, "state"),
    evidencePath,
  };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function workerRoute(taskClass = "bounded_execution") {
  return {
    task_class: taskClass,
    residual_burden: "The fixture needs bounded repository execution.",
    why_lower_cost_route_is_insufficient:
      "A direct answer cannot make and validate the Workspace change.",
    upgrade_trigger:
      "Escalate if the fixture exposes unresolved intent or broader architecture.",
  };
}

function verifierRoute(taskClass = "bounded_evidence_review") {
  return {
    task_class: taskClass,
    residual_burden: "The fixture result needs independent evidence review.",
    why_lower_cost_route_is_insufficient:
      "The result is not decided by one fully mechanical assertion.",
    upgrade_trigger:
      "Escalate if verification requires a new system-level judgment.",
  };
}

function readyPlan(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "ready",
    summary: "Delegation is ready",
    worker_task: "Implement the requested fixture change",
    worker_route: workerRoute(),
    verifier_route: verifierRoute(),
    completion_criteria: ["The fixture change is present"],
    questions: [],
    blocker: null,
    ...overrides,
  };
}

function completedWorker(summary = "Worker completed the fixture change") {
  return {
    status: "completed",
    summary,
    result_path: null,
    questions: [],
    blocker: null,
  };
}

function passedVerification(
  evidencePath: string,
  summary = "Independent verification passed",
) {
  return {
    status: "passed",
    summary,
    findings: [],
    evidence_references: [
      {
        claim: "The fixture completion criteria are satisfied",
        artifact_path: evidencePath,
      },
    ],
    result_path: null,
    questions: [],
    blocker: null,
  };
}

function finalCompletion(summary = "Verified the fixture change") {
  return {
    status: "completed",
    summary,
    result_path: null,
    questions: [],
    blocker: null,
  };
}

async function expectInterruptedRun(
  fixture: ReturnType<typeof createFixture>,
  workflowId: string,
  steps: FakeStep[],
  input: Record<string, unknown> = {},
): Promise<void> {
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: new FakeAgentRunner(steps),
    leaseMs: 60_000,
  });
  try {
    await assert.rejects(
      controller.run({
        workflow_id: workflowId,
        request: "Recover one fixture workflow",
        workspace: fixture.workspace,
        ...input,
      }),
      WorkflowInterruptedError,
    );
    assert.equal(controller.store.getStoredWorkflow(workflowId)?.status, "running");
    controller.store.database
      .prepare("UPDATE workflows SET lease_expires_at = ? WHERE id = ?")
      .run("1970-01-01T00:00:00.000Z", workflowId);
  } finally {
    controller.close();
  }
}

test("runs Orchestrator -> Worker -> Verifier -> same Orchestrator and persists the result", async (t) => {
  const fixture = createFixture();
  const runner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "orchestrator-thread",
      output: {
        status: "ready",
        summary: "Delegation is ready",
        worker_task: "Implement the requested fixture change",
        worker_route: workerRoute(),
        verifier_route: verifierRoute(),
        completion_criteria: ["The fixture change is present", "Tests pass"],
        questions: [],
        blocker: null,
      },
      usage: planUsage,
      journal: "# Journal\n\nThe worker task and completion criteria are ready.\n",
    },
    {
      kind: "start",
      threadId: "worker-thread",
      output: {
        status: "completed",
        summary: "Worker completed the fixture change",
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: workerUsage,
      journal: "# Journal\n\nThe requested fixture change is implemented and tested.\n",
      result:
        "# Detailed implementation report\n\n" +
        "DECISIVE_EVIDENCE_REFERENCE: the complete audit matrix remains here.\n",
    },
    {
      kind: "start",
      threadId: "verifier-thread",
      output: {
        status: "passed",
        summary: "Independent verification passed",
        findings: [],
        evidence_references: [
          {
            claim: "The fixture change is present and tests pass",
            artifact_path: fixture.evidencePath,
          },
        ],
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: verifierUsage,
      journal: "# Journal\n\nIndependent evidence supports the Worker result.\n",
    },
    {
      kind: "continue",
      threadId: "orchestrator-thread",
      output: {
        status: "completed",
        summary: "Verified the fixture change",
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: orchestratorCumulativeUsage,
      journal: "# Journal\n\nThe verified result satisfies the original request.\n",
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Make and verify one fixture change",
    workspace: fixture.workspace,
  });

  assert.equal(output.status, "completed");
  assert.equal(output.summary, "Verified the fixture change");
  assert.deepEqual(
    output.usage,
    sumUsage(orchestratorCumulativeUsage, workerUsage, verifierUsage),
  );
  assert.deepEqual(
    runner.calls.map((call) => [call.kind, call.role, call.profile]),
    [
      ["start", "orchestrator", "sol_high"],
      ["start", "worker", "luna_xhigh"],
      ["start", "verifier", "terra_high"],
      ["continue", "orchestrator", "sol_high"],
    ],
  );
  const planCall = runner.calls[0];
  assert.equal(planCall?.kind, "start");
  if (planCall?.kind === "start") {
    assert.match(planCall.prompt, /do not include internal workflow steps/);
  }
  const workerCall = runner.calls[1];
  assert.equal(workerCall?.kind, "start");
  if (workerCall?.kind === "start") {
    assert.match(workerCall.prompt, /Verifier runs only after your turn finishes/);
  }
  const verifierCall = runner.calls[2];
  assert.equal(verifierCall?.kind, "start");
  if (verifierCall?.kind === "start") {
    assert.doesNotMatch(verifierCall.prompt, /Worker journal:/);
    assert.match(verifierCall.prompt, /external evidence-first perspective/);
  }
  const finalCall = runner.calls[3];
  assert.equal(finalCall?.kind, "continue");
  if (finalCall?.kind === "continue") {
    assert.equal(finalCall.threadId, "orchestrator-thread");
    assert.match(finalCall.prompt, /Worker completed the fixture change/);
    assert.match(finalCall.prompt, /Independent verification passed/);
    assert.doesNotMatch(finalCall.prompt, /Worker journal:/);
  }

  const orchestratorDir = join(output.task_dir, "orchestrator");
  const workerDir = join(output.task_dir, "workers", "worker-1");
  const verifierDir = join(output.task_dir, "verifier");
  assert.equal(output.result_path, join(orchestratorDir, "result.md"));
  assert.equal(mode(join(orchestratorDir, "task.md")), 0o444);
  assert.equal(mode(join(orchestratorDir, "result.md")), 0o444);
  assert.equal(mode(join(workerDir, "task.md")), 0o444);
  assert.equal(mode(join(workerDir, "result.md")), 0o444);
  assert.equal(mode(join(verifierDir, "task.md")), 0o444);
  assert.equal(mode(join(verifierDir, "result.md")), 0o444);
  assert.notEqual(mode(join(orchestratorDir, "journal.md")) & 0o200, 0);
  assert.match(
    readFileSync(join(workerDir, "task.md"), "utf8"),
    /Implement the requested fixture change/,
  );
  assert.match(
    readFileSync(join(orchestratorDir, "result.md"), "utf8"),
    /Verified the fixture change/,
  );
  assert.match(
    readFileSync(join(verifierDir, "result.md"), "utf8"),
    /Independent verification passed/,
  );
  assert.match(
    readFileSync(join(workerDir, "result.md"), "utf8"),
    /DECISIVE_EVIDENCE_REFERENCE/,
  );
  assert.match(
    readFileSync(join(orchestratorDir, "result.md"), "utf8"),
    new RegExp(fixture.evidencePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );

  const workflow = controller.store.getWorkflow(output.workflow_id);
  assert.equal(workflow?.status, "completed");
  assert.deepEqual(JSON.parse(String(workflow?.usage_json)), output.usage);
  const trace = buildWorkflowTrace(controller.store, output.workflow_id);
  assert.equal(trace.evidence[0]?.artifact_path, fixture.evidencePath);
  assert.equal(trace.evidence[0]?.issue, "The fixture change is present and tests pass");

  const runs = controller.store.listAgentRuns(output.workflow_id);
  assert.equal(runs.length, 3);
  const orchestratorRun = runs.find((run) => run.role === "orchestrator");
  const workerRun = runs.find((run) => run.role === "worker");
  const verifierRun = runs.find((run) => run.role === "verifier");
  assert.ok(orchestratorRun);
  assert.ok(workerRun);
  assert.ok(verifierRun);
  assert.equal(orchestratorRun.status, "completed");
  assert.equal(orchestratorRun.profile, "sol_high");
  assert.equal(orchestratorRun.model, "gpt-5.6-sol");
  assert.equal(orchestratorRun.reasoning_effort, "high");
  assert.equal(orchestratorRun.requested_service_tier, "default");
  assert.equal(orchestratorRun.thread_id, "orchestrator-thread");
  assert.deepEqual(
    JSON.parse(String(orchestratorRun.usage_json)),
    orchestratorCumulativeUsage,
  );
  assert.equal(workerRun.status, "completed");
  assert.equal(workerRun.profile, "luna_xhigh");
  assert.equal(workerRun.thread_id, "worker-thread");
  assert.equal(workerRun.parent_run_id, orchestratorRun.id);
  assert.equal(verifierRun.status, "completed");
  assert.equal(verifierRun.profile, "terra_high");
  assert.equal(verifierRun.thread_id, "verifier-thread");
  assert.equal(verifierRun.parent_run_id, orchestratorRun.id);
  assert.deepEqual(
    JSON.parse(String(verifierRun.usage_json)),
    verifierUsage,
  );

  const checkpoints = controller.store.listCheckpoints(output.workflow_id);
  assert.deepEqual(
    checkpoints.map((checkpoint) => checkpoint.kind),
    [
      "workflow.accepted",
      "orchestrator.planned",
      "worker.dispatched",
      "worker.completed",
      "verifier.dispatched",
      "verifier.completed",
      "orchestrator.completed",
    ],
  );
  const checkpointRepository = new CheckpointRepository({
    workTree: output.task_dir,
    gitDir: join(
      fixture.stateDir,
      "checkpoints",
      `${output.workflow_id}.git`,
    ),
  });
  assert.match(
    checkpointRepository.readFileAt(
      String(checkpoints[0]?.commit_id),
      "orchestrator/journal.md",
    ),
    /execution has not started/,
  );
  assert.match(
    checkpointRepository.readFileAt(
      String(checkpoints[1]?.commit_id),
      "orchestrator/journal.md",
    ),
    /completion criteria are ready/,
  );
  assert.match(
    checkpointRepository.readFileAt(
      String(checkpoints[3]?.commit_id),
      "workers/worker-1/result.md",
    ),
    /DECISIVE_EVIDENCE_REFERENCE/,
  );
  assert.match(
    checkpointRepository.readFileAt(
      String(checkpoints.at(-1)?.commit_id),
      "orchestrator/journal.md",
    ),
    /satisfies the original request/,
  );

  const events = controller.store.database
    .prepare(
      "SELECT type FROM events WHERE workflow_id = ? ORDER BY sequence",
    )
    .all(output.workflow_id) as { type: string }[];
  assert.deepEqual(
    events
      .map((event) => event.type)
      .filter(
        (type) =>
          type !== "checkpoint.committed" &&
          type !== "agent.thread_started" &&
          type !== "orchestrator.finalizing",
      ),
    [
      "workflow.started",
      "agent.dispatched",
      "orchestrator.planned",
      "agent.dispatched",
      "worker.completed",
      "agent.completed",
      "agent.dispatched",
      "verifier.completed",
      "agent.completed",
      "orchestrator.completed",
      "agent.completed",
      "workflow.terminal",
    ],
  );
});

test("runs an explicit single-Worker fast path with independent verification", async (t) => {
  const fixture = createFixture();
  const runner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "fast-worker-thread",
      output: {
        status: "completed",
        summary: "The bounded change is complete",
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "fast-verifier-thread",
      output: {
        status: "passed",
        summary: "The observable criterion is satisfied",
        findings: [],
        evidence_references: [
          {
            claim: "The bounded result is observable",
            artifact_path: fixture.evidencePath,
          },
        ],
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: verifierUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Make the one bounded fixture change",
    workspace: fixture.workspace,
    execution_route: "single_worker",
    completion_criteria: ["The bounded fixture change is observable"],
  });

  assert.equal(output.status, "completed");
  assert.equal(output.execution_route, "single_worker");
  assert.equal(output.retry_route, null);
  assert.deepEqual(output.usage, sumUsage(workerUsage, verifierUsage));
  assert.deepEqual(
    runner.calls.map((call) => [call.role, call.profile]),
    [
      ["worker", "luna_high"],
      ["verifier", "luna_high"],
    ],
  );
  const fastWorkerCall = runner.calls[0];
  assert.equal(fastWorkerCall?.kind, "start");
  if (fastWorkerCall?.kind === "start") {
    assert.match(fastWorkerCall.prompt, /Return "escalate"/);
    assert.match(fastWorkerCall.prompt, /do not spend tool calls editing/);
  }
  const fastVerifierCall = runner.calls[1];
  assert.equal(fastVerifierCall?.kind, "start");
  if (fastVerifierCall?.kind === "start") {
    assert.match(fastVerifierCall.prompt, /do not spend tool calls editing/);
  }
  assert.match(
    readFileSync(join(output.task_dir, "workers", "worker-1", "journal.md"), "utf8"),
    /The bounded change is complete/,
  );
  assert.match(
    readFileSync(join(output.task_dir, "verifier", "journal.md"), "utf8"),
    /The observable criterion is satisfied/,
  );
  assert.deepEqual(
    controller.store
      .listCheckpoints(output.workflow_id)
      .map((checkpoint) => checkpoint.kind),
    [
      "workflow.accepted",
      "worker.dispatched",
      "worker.completed",
      "verifier.dispatched",
      "verifier.completed",
      "workflow.completed",
    ],
  );
  assert.equal(
    controller.store.getWorkflow(output.workflow_id)?.execution_route,
    "single_worker",
  );
});

test("rejects passed Verification without Evidence References on the fast path", async (t) => {
  const fixture = createFixture();
  const runner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "fast-no-evidence-worker",
      output: completedWorker(),
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "fast-no-evidence-verifier",
      output: {
        status: "passed",
        summary: "The Verifier claimed success without durable evidence",
        findings: [],
        evidence_references: [],
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: verifierUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Reject a fast completion without evidence",
    workspace: fixture.workspace,
    execution_route: "single_worker",
    completion_criteria: ["The result has durable independent evidence"],
  });

  assert.equal(output.status, "failed");
  assert.equal(output.failure_kind, "verification_rejected");
  assert.equal(runner.calls.length, 2);
  assert.match(
    readFileSync(String(output.result_path), "utf8"),
    /passed without an Evidence Reference/,
  );
});

test("rejects passed Verification without Evidence References before final orchestration", async (t) => {
  const fixture = createFixture();
  const runner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "no-evidence-orchestrator",
      output: readyPlan(),
      usage: planUsage,
    },
    {
      kind: "start",
      threadId: "no-evidence-worker",
      output: completedWorker(),
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "no-evidence-verifier",
      output: {
        status: "passed",
        summary: "The Verifier claimed success without durable evidence",
        findings: [],
        evidence_references: [],
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: verifierUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Reject an orchestrated completion without evidence",
    workspace: fixture.workspace,
  });

  assert.equal(output.status, "failed");
  assert.equal(output.failure_kind, "verification_rejected");
  assert.deepEqual(
    runner.calls.map((call) => call.role),
    ["orchestrator", "worker", "verifier"],
  );
});

test("exits the fast path with an explicit orchestrated retry route", async (t) => {
  const fixture = createFixture();
  const runner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "fast-worker-escalation-thread",
      output: {
        status: "escalate",
        summary: "The change requires an architectural decision",
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: workerUsage,
      journal:
        "# Journal\n\nThe apparent small change crosses an architectural boundary.\n",
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Make the apparently bounded fixture change",
    workspace: fixture.workspace,
    execution_route: "single_worker",
    completion_criteria: ["The requested behavior is observable"],
  });

  assert.equal(output.status, "failed");
  assert.equal(output.blocker, "route_escalation_required");
  assert.equal(output.retry_route, "orchestrated");
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(
    controller.store
      .listCheckpoints(output.workflow_id)
      .map((checkpoint) => checkpoint.kind),
    [
      "workflow.accepted",
      "worker.dispatched",
      "worker.completed",
      "workflow.escalated",
    ],
  );
});

test("escalates a fast-path result rejected by independent verification", async (t) => {
  const fixture = createFixture();
  const runner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "fast-worker-rejected-thread",
      output: {
        status: "completed",
        summary: "The bounded change is complete",
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "fast-verifier-findings-thread",
      output: {
        status: "findings",
        summary: "The observable criterion is not satisfied",
        findings: [
          {
            issue: "The expected output is absent",
            evidence: "A focused workspace check found no expected output",
          },
        ],
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: verifierUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Make the bounded fixture change",
    workspace: fixture.workspace,
    execution_route: "single_worker",
    completion_criteria: ["The expected output exists"],
  });

  assert.equal(output.status, "failed");
  assert.equal(output.retry_route, "orchestrated");
  assert.match(output.blocker ?? "", /expected output is absent/);
  assert.deepEqual(
    controller.store
      .listCheckpoints(output.workflow_id)
      .map((checkpoint) => checkpoint.kind),
    [
      "workflow.accepted",
      "worker.dispatched",
      "worker.completed",
      "verifier.dispatched",
      "verifier.completed",
      "workflow.escalated",
    ],
  );
});

test("independent findings reject the result without a final Orchestrator turn", async (t) => {
  const fixture = createFixture();
  const runner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "orchestrator-rejection-thread",
      output: {
        status: "ready",
        summary: "Delegation is ready",
        worker_task: "Implement the requested fixture change",
        worker_route: workerRoute("long_horizon_execution"),
        verifier_route: verifierRoute("irreducible_review"),
        completion_criteria: ["The requested behavior is observable"],
        questions: [],
        blocker: null,
      },
      usage: planUsage,
    },
    {
      kind: "start",
      threadId: "worker-rejected-thread",
      output: {
        status: "completed",
        summary: "Worker claims completion",
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "verifier-findings-thread",
      output: {
        status: "findings",
        summary: "The requested behavior is not implemented",
        findings: [
          {
            issue: "The expected file is absent",
            evidence: "A workspace listing contains no expected.txt",
          },
        ],
        result_path: null,
        questions: [],
        blocker: null,
      },
      usage: verifierUsage,
    },
    {
      kind: "continue",
      threadId: "orchestrator-rejection-thread",
      output: {
        status: "failed",
        summary: "Independent evidence shows the task is incomplete",
        result_path: null,
        questions: [],
        blocker: "The expected file is absent",
      },
      usage: orchestratorCumulativeUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Create the expected fixture output",
    workspace: fixture.workspace,
  });

  assert.equal(output.status, "failed");
  assert.equal(output.summary, "The requested behavior is not implemented");
  assert.equal(output.failure_kind, "verification_rejected");
  assert.equal(runner.calls.length, 3);
  assert.match(
    readFileSync(join(output.task_dir, "verifier", "result.md"), "utf8"),
    /workspace listing contains no expected\.txt/,
  );
  assert.deepEqual(
    output.usage,
    sumUsage(planUsage, workerUsage, verifierUsage),
  );
});

test("returns needs_input from the planning turn without starting a Worker", async (t) => {
  const fixture = createFixture();
  const runner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "orchestrator-needs-input",
      output: {
        status: "needs_input",
        summary: "A target choice is required",
        worker_task: null,
        worker_route: null,
        verifier_route: null,
        completion_criteria: [],
        questions: ["Which target should be changed?"],
        blocker: null,
      },
      usage: planUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Change the selected target",
    workspace: fixture.workspace,
  });

  assert.equal(output.status, "needs_input");
  assert.deepEqual(output.questions, ["Which target should be changed?"]);
  assert.deepEqual(output.usage, planUsage);
  assert.equal(runner.calls.length, 1);
  assert.equal(existsSync(join(output.task_dir, "workers")), false);
  assert.equal(mode(String(output.result_path)), 0o444);
  const runs = controller.store.listAgentRuns(output.workflow_id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "completed");
  const terminalEvents = controller.store.database
    .prepare(
      "SELECT type, payload_json FROM events WHERE workflow_id = ? AND type = 'workflow.terminal'",
    )
    .all(output.workflow_id) as { type: string; payload_json: string }[];
  assert.equal(terminalEvents.length, 1);
  assert.equal(JSON.parse(terminalEvents[0]?.payload_json ?? "{}").status, "needs_input");
});

test("converts a runner failure into a failed workflow", async (t) => {
  const fixture = createFixture();
  const runner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "orchestrator-before-worker-failure",
      output: {
        status: "ready",
        summary: "Worker can proceed",
        worker_task: "Run the failing worker fixture",
        worker_route: workerRoute("long_horizon_execution"),
        verifier_route: verifierRoute(),
        completion_criteria: ["Worker reports a result"],
        questions: [],
        blocker: null,
      },
      usage: planUsage,
    },
    {
      kind: "start",
      error: new Error("simulated runner failure"),
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Exercise the failure path",
    workspace: fixture.workspace,
  });

  assert.equal(output.status, "failed");
  assert.equal(output.summary, "simulated runner failure");
  assert.equal(output.blocker, "simulated runner failure");
  assert.deepEqual(output.usage, planUsage);
  assert.equal(output.usage_status, "partial");
  assert.equal(output.failure_kind, "execution_error");
  assert.equal(mode(String(output.result_path)), 0o444);
  assert.match(
    readFileSync(String(output.result_path), "utf8"),
    /simulated runner failure/,
  );

  const runs = controller.store.listAgentRuns(output.workflow_id);
  assert.equal(runs.length, 2);
  assert.deepEqual(
    runs.map((run) => [run.role, run.status, run.error]),
    [
      ["orchestrator", "failed", "simulated runner failure"],
      ["worker", "failed", "simulated runner failure"],
    ],
  );
  const workflow = controller.store.getWorkflow(output.workflow_id);
  assert.equal(workflow?.status, "failed");
  const eventTypes = controller.store.database
    .prepare("SELECT type FROM events WHERE workflow_id = ? ORDER BY sequence")
    .all(output.workflow_id) as { type: string }[];
  assert.deepEqual(
    eventTypes
      .map((event) => event.type)
      .filter(
        (type) =>
          type !== "checkpoint.committed" && type !== "agent.thread_started",
      ),
    [
      "workflow.started",
      "agent.dispatched",
      "orchestrator.planned",
      "agent.dispatched",
      "agent.failed",
      "agent.failed",
      "workflow.execution_failed",
      "workflow.terminal",
    ],
  );
});

test("resumes an interrupted Orchestrator planning turn", async (t) => {
  const fixture = createFixture();
  const workflowId = randomUUID();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  await expectInterruptedRun(fixture, workflowId, [
    {
      kind: "start",
      threadId: "planning-thread",
      startedBeforeError: true,
      error: new WorkflowInterruptedError(),
    },
  ]);

  const runner = new FakeAgentRunner([
    {
      kind: "continue",
      threadId: "planning-thread",
      output: readyPlan(),
      usage: planUsage,
    },
    {
      kind: "start",
      threadId: "planning-worker",
      output: completedWorker(),
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "planning-verifier",
      output: passedVerification(fixture.evidencePath),
      usage: verifierUsage,
    },
    {
      kind: "continue",
      threadId: "planning-thread",
      output: finalCompletion(),
      usage: orchestratorCumulativeUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
    leaseMs: 60_000,
  });
  t.after(() => controller.close());

  const output = await controller.run({
    workflow_id: workflowId,
    request: "Recover one fixture workflow",
    workspace: fixture.workspace,
  });
  assert.equal(output.status, "completed");
  assert.equal(runner.calls[0]?.kind, "continue");
  assert.match(runner.calls[0]?.prompt ?? "", /Controller process was interrupted/);
  assert.equal(
    controller.store.latestEvent(workflowId, "workflow.resumed")?.type,
    "workflow.resumed",
  );
});

test("resumes an interrupted Worker turn without rerunning the Orchestrator plan", async (t) => {
  const fixture = createFixture();
  const workflowId = randomUUID();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  await expectInterruptedRun(fixture, workflowId, [
    {
      kind: "start",
      threadId: "worker-recovery-orchestrator",
      output: readyPlan(),
      usage: planUsage,
    },
    {
      kind: "start",
      threadId: "worker-recovery-thread",
      startedBeforeError: true,
      error: new WorkflowInterruptedError(),
    },
  ]);

  const runner = new FakeAgentRunner([
    {
      kind: "continue",
      threadId: "worker-recovery-thread",
      output: completedWorker(),
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "worker-recovery-verifier",
      output: passedVerification(fixture.evidencePath),
      usage: verifierUsage,
    },
    {
      kind: "continue",
      threadId: "worker-recovery-orchestrator",
      output: finalCompletion(),
      usage: orchestratorCumulativeUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
    leaseMs: 60_000,
  });
  t.after(() => controller.close());

  const output = await controller.run({
    workflow_id: workflowId,
    request: "Recover one fixture workflow",
    workspace: fixture.workspace,
  });
  assert.equal(output.status, "completed");
  assert.deepEqual(
    runner.calls.map((call) => [call.kind, call.role]),
    [
      ["continue", "worker"],
      ["start", "verifier"],
      ["continue", "orchestrator"],
    ],
  );
  assert.match(runner.calls[0]?.prompt ?? "", /Do not blindly repeat side effects/);
});

test("restores the active Journal from the last complete Checkpoint before resuming", async (t) => {
  const fixture = createFixture();
  const workflowId = randomUUID();
  const first = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: new FakeAgentRunner([
      {
        kind: "start",
        threadId: "durable-recovery-orchestrator",
        output: readyPlan(),
        usage: planUsage,
      },
      {
        kind: "start",
        threadId: "durable-recovery-worker",
        startedBeforeError: true,
        error: new WorkflowInterruptedError(),
      },
    ]),
    leaseMs: 60_000,
  });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    first.run({
      workflow_id: workflowId,
      request: "Resume from durable Worker state",
      workspace: fixture.workspace,
    }),
    WorkflowInterruptedError,
  );
  const workflow = first.store.getStoredWorkflow(workflowId);
  const worker = first.store
    .listStoredAgentRuns(workflowId)
    .find((run) => run.role === "worker");
  assert.ok(workflow?.leaseOwner);
  assert.ok(workflow.leaseClaimedAt);
  assert.ok(worker);
  const journalPath = join(worker.taskDir, "journal.md");
  writeFileSync(
    journalPath,
    "# Journal\n\nDURABLE_DECISION=preserve-the-existing-interface\n",
    "utf8",
  );
  const repository = new CheckpointRepository({
    workTree: workflow.taskDir,
    gitDir: join(fixture.stateDir, "checkpoints", `${workflowId}.git`),
  });
  const checkpoint = repository.commit("journal.pre_compact", {
    includeNewResults: false,
    leaseEpoch: workflow.leaseEpoch,
  });
  first.store.recordCheckpoint(
    {
      workflowId,
      owner: workflow.leaseOwner,
      epoch: workflow.leaseEpoch,
      claimedAt: workflow.leaseClaimedAt,
    },
    worker.id,
    checkpoint.kind,
    checkpoint.id,
    "journal.pre_compact",
  );
  writeFileSync(journalPath, "# Journal\n\nCORRUPTED_LIVE_STATE\n", "utf8");
  first.store.database
    .prepare("UPDATE workflows SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", workflowId);
  first.close();

  const runner = new FakeAgentRunner([
    {
      kind: "continue",
      threadId: "durable-recovery-worker",
      output: completedWorker(),
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "durable-recovery-verifier",
      output: passedVerification(fixture.evidencePath),
      usage: verifierUsage,
    },
    {
      kind: "continue",
      threadId: "durable-recovery-orchestrator",
      output: finalCompletion(),
      usage: orchestratorCumulativeUsage,
    },
  ]);
  const resumed = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
    leaseMs: 60_000,
  });
  t.after(() => resumed.close());
  const output = await resumed.run({
    workflow_id: workflowId,
    request: "Resume from durable Worker state",
    workspace: fixture.workspace,
  });

  assert.equal(output.status, "completed");
  assert.match(runner.calls[0]?.journal ?? "", /DURABLE_DECISION/);
  assert.doesNotMatch(runner.calls[0]?.journal ?? "", /CORRUPTED_LIVE_STATE/);
  const restored = resumed.store.latestEvent<Record<string, unknown>>(
    workflowId,
    "journal.restored",
  );
  assert.equal(restored?.payload.commit_id, checkpoint.id);
});

test("fails explicitly when an interrupted run has no readable complete Checkpoint", async (t) => {
  const fixture = createFixture();
  const workflowId = randomUUID();
  await expectInterruptedRun(fixture, workflowId, [
    {
      kind: "start",
      threadId: "missing-checkpoint-orchestrator",
      startedBeforeError: true,
      error: new WorkflowInterruptedError(),
    },
  ]);
  rmSync(join(fixture.stateDir, "checkpoints", `${workflowId}.git`), {
    recursive: true,
    force: true,
  });

  const runner = new FakeAgentRunner([]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
    leaseMs: 60_000,
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });
  const output = await controller.run({
    workflow_id: workflowId,
    request: "Recover one fixture workflow",
    workspace: fixture.workspace,
  });

  assert.equal(output.status, "failed");
  assert.match(output.summary, /no authoritative complete Checkpoint/);
  assert.equal(runner.calls.length, 0);
});

test("resumes an interrupted Verifier turn", async (t) => {
  const fixture = createFixture();
  const workflowId = randomUUID();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  await expectInterruptedRun(fixture, workflowId, [
    {
      kind: "start",
      threadId: "verifier-recovery-orchestrator",
      output: readyPlan(),
      usage: planUsage,
    },
    {
      kind: "start",
      threadId: "verifier-recovery-worker",
      output: completedWorker(),
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "verifier-recovery-thread",
      startedBeforeError: true,
      error: new WorkflowInterruptedError(),
    },
  ]);

  const runner = new FakeAgentRunner([
    {
      kind: "continue",
      threadId: "verifier-recovery-thread",
      output: passedVerification(fixture.evidencePath),
      usage: verifierUsage,
    },
    {
      kind: "continue",
      threadId: "verifier-recovery-orchestrator",
      output: finalCompletion(),
      usage: orchestratorCumulativeUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
    leaseMs: 60_000,
  });
  t.after(() => controller.close());

  const output = await controller.run({
    workflow_id: workflowId,
    request: "Recover one fixture workflow",
    workspace: fixture.workspace,
  });
  assert.equal(output.status, "completed");
  assert.deepEqual(
    runner.calls.map((call) => [call.kind, call.role]),
    [
      ["continue", "verifier"],
      ["continue", "orchestrator"],
    ],
  );
  assert.match(runner.calls[0]?.prompt ?? "", /independent Verification turn/);
});

test("resumes an interrupted final Orchestrator turn", async (t) => {
  const fixture = createFixture();
  const workflowId = randomUUID();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  await expectInterruptedRun(fixture, workflowId, [
    {
      kind: "start",
      threadId: "final-recovery-orchestrator",
      output: readyPlan(),
      usage: planUsage,
    },
    {
      kind: "start",
      threadId: "final-recovery-worker",
      output: completedWorker(),
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "final-recovery-verifier",
      output: passedVerification(fixture.evidencePath),
      usage: verifierUsage,
    },
    {
      kind: "continue",
      threadId: "final-recovery-orchestrator",
      error: new WorkflowInterruptedError(),
    },
  ]);

  const runner = new FakeAgentRunner([
    {
      kind: "continue",
      threadId: "final-recovery-orchestrator",
      output: finalCompletion(),
      usage: orchestratorCumulativeUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
    leaseMs: 60_000,
  });
  t.after(() => controller.close());

  const output = await controller.run({
    workflow_id: workflowId,
    request: "Recover one fixture workflow",
    workspace: fixture.workspace,
  });
  assert.equal(output.status, "completed");
  assert.equal(runner.calls.length, 1);
  assert.match(runner.calls[0]?.prompt ?? "", /final judgment turn/);
});

test("resumes interrupted fast-path Worker and Verifier turns", async (t) => {
  const fixture = createFixture();
  const criteria = ["The bounded result is observable"];
  const workerWorkflowId = randomUUID();
  const verifierWorkflowId = randomUUID();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  await expectInterruptedRun(
    fixture,
    workerWorkflowId,
    [
      {
        kind: "start",
        threadId: "fast-recovery-worker",
        startedBeforeError: true,
        result: "# Result\n\nstale interrupted result\n",
        error: new WorkflowInterruptedError(),
      },
    ],
    { execution_route: "single_worker", completion_criteria: criteria },
  );
  const workerRunner = new FakeAgentRunner([
    {
      kind: "continue",
      threadId: "fast-recovery-worker",
      output: completedWorker("Fast Worker recovered"),
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "fast-recovery-worker-verifier",
      output: passedVerification(fixture.evidencePath),
      usage: verifierUsage,
    },
  ]);
  const workerController = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: workerRunner,
    leaseMs: 60_000,
  });
  const workerOutput = await workerController.run({
    workflow_id: workerWorkflowId,
    request: "Recover one fixture workflow",
    workspace: fixture.workspace,
    execution_route: "single_worker",
    completion_criteria: criteria,
  });
  assert.equal(workerOutput.status, "completed");
  assert.match(workerRunner.calls[0]?.prompt ?? "", /bounded single-Worker turn/);
  assert.doesNotMatch(
    readFileSync(
      join(workerOutput.task_dir, "workers", "worker-1", "result.md"),
      "utf8",
    ),
    /stale interrupted result/,
  );
  workerController.close();

  await expectInterruptedRun(
    fixture,
    verifierWorkflowId,
    [
      {
        kind: "start",
        threadId: "fast-verifier-worker",
        output: completedWorker(),
        usage: workerUsage,
      },
      {
        kind: "start",
        threadId: "fast-recovery-verifier",
        startedBeforeError: true,
        error: new WorkflowInterruptedError(),
      },
    ],
    { execution_route: "single_worker", completion_criteria: criteria },
  );
  const verifierRunner = new FakeAgentRunner([
    {
      kind: "continue",
      threadId: "fast-recovery-verifier",
      output: passedVerification(fixture.evidencePath),
      usage: verifierUsage,
    },
  ]);
  const verifierController = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: verifierRunner,
    leaseMs: 60_000,
  });
  const verifierOutput = await verifierController.run({
    workflow_id: verifierWorkflowId,
    request: "Recover one fixture workflow",
    workspace: fixture.workspace,
    execution_route: "single_worker",
    completion_criteria: criteria,
  });
  assert.equal(verifierOutput.status, "completed");
  assert.deepEqual(
    verifierRunner.calls.map((call) => [call.kind, call.role]),
    [["continue", "verifier"]],
  );
  verifierController.close();
});

test("returns an existing terminal outcome without another Agent call", async (t) => {
  const fixture = createFixture();
  const workflowId = randomUUID();
  const firstRunner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "terminal-worker",
      output: completedWorker(),
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "terminal-verifier",
      output: passedVerification(fixture.evidencePath),
      usage: verifierUsage,
    },
  ]);
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: firstRunner,
  });
  const input = {
    workflow_id: workflowId,
    request: "Return the same terminal result",
    workspace: fixture.workspace,
    execution_route: "single_worker" as const,
    completion_criteria: ["The result is observable"],
  };
  const first = await controller.run(input);
  controller.close();

  const retryRunner = new FakeAgentRunner([]);
  const retryController = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: retryRunner,
  });
  t.after(() => {
    retryController.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });
  const second = await retryController.run(input);
  assert.deepEqual(second, first);
  assert.equal(retryRunner.calls.length, 0);
});

test("rejects a reused workflow ID with different immutable input", async (t) => {
  const fixture = createFixture();
  const workflowId = randomUUID();
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: new FakeAgentRunner([
      {
        kind: "start",
        threadId: "identity-worker",
        output: completedWorker(),
        usage: workerUsage,
      },
      {
        kind: "start",
        threadId: "identity-verifier",
        output: passedVerification(fixture.evidencePath),
        usage: verifierUsage,
      },
    ]),
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });
  await controller.run({
    workflow_id: workflowId,
    request: "Original request",
    workspace: fixture.workspace,
    execution_route: "single_worker",
    completion_criteria: ["Original criterion"],
  });
  await assert.rejects(
    controller.run({
      workflow_id: workflowId,
      request: "Changed request",
      workspace: fixture.workspace,
      execution_route: "single_worker",
      completion_criteria: ["Original criterion"],
    }),
    /cannot be reused with different request/,
  );
});

test("allows only one Controller lease holder for a running workflow", (t) => {
  const fixture = createFixture();
  const workflowId = randomUUID();
  const first = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: new FakeAgentRunner([]),
  });
  const second = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: new FakeAgentRunner([]),
  });
  t.after(() => {
    first.close();
    second.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });
  first.store.createWorkflow(
    workflowId,
    "Lease one workflow",
    fixture.workspace,
    join(fixture.stateDir, "tasks", workflowId),
    "orchestrated",
    [],
    emptyUsage(),
  );
  const firstLease = first.store.claimWorkflow(workflowId, "owner-a", 60_000);
  assert.ok(firstLease);
  assert.equal(second.store.claimWorkflow(workflowId, "owner-b", 60_000), null);
  first.store.releaseWorkflow(firstLease);
  assert.ok(second.store.claimWorkflow(workflowId, "owner-b", 60_000));
});

test("fences a stale Controller after lease takeover", async (t) => {
  const fixture = createFixture();
  const workflowId = randomUUID();
  const staleRunner = new DeferredPlanningRunner();
  const stale = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: staleRunner,
    leaseMs: 60_000,
  });
  const winnerRunner = new FakeAgentRunner([
    {
      kind: "continue",
      threadId: "takeover-orchestrator",
      output: readyPlan(),
      usage: planUsage,
    },
    {
      kind: "start",
      threadId: "takeover-worker",
      output: completedWorker(),
      usage: workerUsage,
    },
    {
      kind: "start",
      threadId: "takeover-verifier",
      output: passedVerification(fixture.evidencePath),
      usage: verifierUsage,
    },
    {
      kind: "continue",
      threadId: "takeover-orchestrator",
      output: finalCompletion("takeover winner completed"),
      usage: orchestratorCumulativeUsage,
    },
  ]);
  const winner = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: winnerRunner,
    leaseMs: 60_000,
  });
  t.after(() => {
    stale.close();
    winner.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const stalePromise = stale.run({
    workflow_id: workflowId,
    request: "Exercise Controller takeover fencing",
    workspace: fixture.workspace,
  });
  await staleRunner.started;
  stale.store.database
    .prepare("UPDATE workflows SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", workflowId);

  const winnerOutput = await winner.run({
    workflow_id: workflowId,
    request: "Exercise Controller takeover fencing",
    workspace: fixture.workspace,
  });
  staleRunner.complete(
    readyPlan({ summary: "stale Controller should be ignored" }),
    planUsage,
  );
  const staleOutput = await stalePromise;

  assert.equal(winnerOutput.summary, "takeover winner completed");
  assert.deepEqual(staleOutput, winnerOutput);
  assert.equal(staleRunner.calls.length, 1);
  const eventTypes = winner.store
    .listStoredEvents(workflowId)
    .map((event) => event.type);
  assert.equal(
    eventTypes.filter((type) => type === "orchestrator.planned").length,
    1,
  );
  assert.equal(
    eventTypes.filter((type) => type === "worker.completed").length,
    1,
  );
  assert.equal(
    eventTypes.filter((type) => type === "verifier.completed").length,
    1,
  );
  assert.equal(
    winner.store.listStoredAgentRuns(workflowId).filter(
      (run) => run.role === "verifier",
    ).length,
    1,
  );
});

test("requires user approval after an upstream cyber_policy classification", async (t) => {
  const fixture = createFixture();
  const message =
    "Codex stream failed: This content was flagged for possible cybersecurity risk. " +
    "If this seems wrong, try rephrasing your request. To get authorized for " +
    "security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber";
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: new FakeAgentRunner([
      { kind: "start", error: new Error(message) },
    ]),
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Perform an ordinary authorized review",
    workspace: fixture.workspace,
  });

  assert.equal(output.status, "failed");
  assert.equal(output.failure_kind, "cyber_policy");
  assert.equal(output.recovery_requires_user_approval, true);
  assert.equal(output.retry_route, null);
  assert.equal(output.usage_status, "unknown");
  assert.equal(output.usage, null);
  assert.equal(
    controller.store.latestEvent<Record<string, unknown>>(
      output.workflow_id,
      "workflow.execution_failed",
    )?.payload.failure_kind,
    "cyber_policy",
  );
  const decisionId = randomUUID();
  const decision = controller.recordRecoveryDecision({
    workflow_id: output.workflow_id,
    decision_id: decisionId,
    decision: "approved",
    note: "User explicitly approved a semantically different recovery attempt.",
  });
  assert.equal(decision.decision, "approved");
  assert.equal(
    controller.store.latestEvent<Record<string, unknown>>(
      output.workflow_id,
      "workflow.recovery_approved",
    )?.payload.decision_id,
    decisionId,
  );
  assert.deepEqual(
    controller.recordRecoveryDecision({
      workflow_id: output.workflow_id,
      decision_id: decisionId,
      decision: "approved",
      note: "User explicitly approved a semantically different recovery attempt.",
    }),
    decision,
  );
  assert.throws(
    () =>
      controller.recordRecoveryDecision({
        workflow_id: output.workflow_id,
        decision_id: decisionId,
        decision: "denied",
      }),
    /already recorded with different content/,
  );
});

test("keeps usage unknown when a failed workflow has no usage snapshot", async (t) => {
  const fixture = createFixture();
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner: new FakeAgentRunner([
      { kind: "start", error: new Error("failed before usage") },
    ]),
  });
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const output = await controller.run({
    request: "Fail before usage is reported",
    workspace: fixture.workspace,
  });
  assert.equal(output.usage_status, "unknown");
  assert.equal(output.usage, null);
});

test("classifies an explicit caller abort as cancelled", async (t) => {
  const fixture = createFixture();
  const runner = new AbortableRunner();
  const controller = new WorkflowController({
    stateDir: fixture.stateDir,
    runner,
  });
  const abort = new AbortController();
  t.after(() => {
    controller.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const pending = controller.run(
    {
      request: "Cancel this workflow while its first turn is running",
      workspace: fixture.workspace,
    },
    abort.signal,
  );
  await runner.started;
  abort.abort();
  const output = await pending;

  assert.equal(output.status, "cancelled");
  assert.equal(output.failure_kind, null);
  assert.equal(output.recovery_requires_user_approval, false);
  assert.equal(output.usage_status, "unknown");
  assert.equal(controller.store.listStoredAgentRuns(output.workflow_id)[0]?.status, "cancelled");
});

test("cancels before dispatching a Verifier when the Worker ignores AbortSignal", async (t) => {
  for (const executionRoute of ["orchestrated", "single_worker"] as const) {
    const fixture = createFixture();
    const runner = new AbortIgnoringWorkerRunner(
      executionRoute === "orchestrated",
    );
    const controller = new WorkflowController({
      stateDir: fixture.stateDir,
      runner,
    });
    const abort = new AbortController();
    try {
      const pending = controller.run(
        {
          request: `Cancel an abort-ignoring ${executionRoute} Worker`,
          workspace: fixture.workspace,
          execution_route: executionRoute,
          completion_criteria:
            executionRoute === "single_worker"
              ? ["The bounded result is observable"]
              : [],
        },
        abort.signal,
      );
      await runner.workerStarted;
      abort.abort();
      const output = await pending;

      assert.equal(output.status, "cancelled");
      assert.equal(runner.calls.at(-1), "worker");
      assert.equal(runner.calls.includes("verifier"), false);
      assert.equal(
        controller.store.latestEvent(output.workflow_id, "worker.completed"),
        undefined,
      );
      assert.equal(
        controller.store
          .listStoredEvents(output.workflow_id)
          .filter((event) => event.type === "workflow.terminal").length,
        1,
      );
    } finally {
      controller.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
