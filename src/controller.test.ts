import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
import {
  emptyUsage,
  type AgentRole,
  type AgentUsage,
} from "./contracts.js";
import { WorkflowController } from "./controller.js";

interface FakeStep {
  kind: "start" | "continue";
  threadId?: string;
  output?: unknown;
  usage?: AgentUsage | null;
  error?: Error;
}

type RunnerCall =
  | {
      kind: "start";
      role: AgentRole;
      workspace: string;
      taskDir: string;
      prompt: string;
    }
  | {
      kind: "continue";
      role: AgentRole;
      threadId: string;
      workspace: string;
      taskDir: string;
      prompt: string;
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
      workspace: request.workspace,
      taskDir: request.taskDir,
      prompt: request.prompt,
    });
    return this.take("start", request);
  }

  async continue<T>(
    request: ContinueAgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    this.calls.push({
      kind: "continue",
      role: request.role,
      threadId: request.threadId,
      workspace: request.workspace,
      taskDir: request.taskDir,
      prompt: request.prompt,
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
    if (step.error) {
      throw step.error;
    }
    assert.ok(step.threadId, `Fake ${expectedKind} step needs a thread ID`);
    return {
      threadId: step.threadId,
      output: request.schema.parse(step.output),
      usage: step.usage ?? null,
    };
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
} {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-controller-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { root, workspace, stateDir: join(root, "state") };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test("runs Orchestrator -> Worker -> same Orchestrator and persists the result", async (t) => {
  const fixture = createFixture();
  const runner = new FakeAgentRunner([
    {
      kind: "start",
      threadId: "orchestrator-thread",
      output: {
        status: "ready",
        summary: "Delegation is ready",
        worker_task: "Implement the requested fixture change",
        completion_criteria: ["The fixture change is present", "Tests pass"],
        questions: [],
        blocker: null,
      },
      usage: planUsage,
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
    sumUsage(orchestratorCumulativeUsage, workerUsage),
  );
  assert.deepEqual(
    runner.calls.map((call) => [call.kind, call.role]),
    [
      ["start", "orchestrator"],
      ["start", "worker"],
      ["continue", "orchestrator"],
    ],
  );
  const finalCall = runner.calls[2];
  assert.equal(finalCall?.kind, "continue");
  if (finalCall?.kind === "continue") {
    assert.equal(finalCall.threadId, "orchestrator-thread");
    assert.match(finalCall.prompt, /Worker completed the fixture change/);
  }

  const orchestratorDir = join(output.task_dir, "orchestrator");
  const workerDir = join(output.task_dir, "workers", "worker-1");
  assert.equal(output.result_path, join(orchestratorDir, "result.md"));
  assert.equal(mode(join(orchestratorDir, "task.md")), 0o444);
  assert.equal(mode(join(orchestratorDir, "result.md")), 0o444);
  assert.equal(mode(join(workerDir, "task.md")), 0o444);
  assert.equal(mode(join(workerDir, "result.md")), 0o444);
  assert.notEqual(mode(join(orchestratorDir, "journal.md")) & 0o200, 0);
  assert.match(
    readFileSync(join(workerDir, "task.md"), "utf8"),
    /Implement the requested fixture change/,
  );
  assert.match(
    readFileSync(join(orchestratorDir, "result.md"), "utf8"),
    /Verified the fixture change/,
  );

  const workflow = controller.store.getWorkflow(output.workflow_id);
  assert.equal(workflow?.status, "completed");
  assert.deepEqual(JSON.parse(String(workflow?.usage_json)), output.usage);

  const runs = controller.store.listAgentRuns(output.workflow_id);
  assert.equal(runs.length, 2);
  const orchestratorRun = runs.find((run) => run.role === "orchestrator");
  const workerRun = runs.find((run) => run.role === "worker");
  assert.ok(orchestratorRun);
  assert.ok(workerRun);
  assert.equal(orchestratorRun.status, "completed");
  assert.equal(orchestratorRun.thread_id, "orchestrator-thread");
  assert.deepEqual(
    JSON.parse(String(orchestratorRun.usage_json)),
    orchestratorCumulativeUsage,
  );
  assert.equal(workerRun.status, "completed");
  assert.equal(workerRun.thread_id, "worker-thread");
  assert.equal(workerRun.parent_run_id, orchestratorRun.id);

  const events = controller.store.database
    .prepare(
      "SELECT type FROM events WHERE workflow_id = ? ORDER BY sequence",
    )
    .all(output.workflow_id) as { type: string }[];
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "workflow.started",
      "orchestrator.planned",
      "worker.completed",
      "orchestrator.completed",
      "workflow.completed",
    ],
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
});
