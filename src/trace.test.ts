import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { emptyUsage, type AgentUsage } from "./contracts.js";
import { StateStore } from "./state.js";
import { formatWorkflowTrace } from "./trace-format.js";
import { buildWorkflowTrace, loadWorkflowTrace } from "./trace.js";
import { startTraceWebViewer } from "./trace-web.js";

const orchestratorUsage: AgentUsage = {
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

function totalUsage(): AgentUsage {
  return {
    input_tokens: 42,
    cached_input_tokens: 10,
    cache_write_input_tokens: 4,
    output_tokens: 13,
    reasoning_output_tokens: 17,
  };
}

function writeArtifacts(directory: string, label: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "task.md"), `# Task\n\n${label}\n`, "utf8");
  writeFileSync(
    join(directory, "journal.md"),
    `# Journal\n\n${label} progress\n`,
    "utf8",
  );
  writeFileSync(
    join(directory, "result.md"),
    `# Result\n\n${label} result\n`,
    "utf8",
  );
}

function createTraceFixture(): {
  root: string;
  stateDir: string;
  workflowId: string;
  evidencePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-trace-"));
  const stateDir = join(root, "state");
  const workflowId = "00000000-0000-4000-8000-000000000101";
  const workspace = join(root, "workspace");
  const taskDir = join(stateDir, "tasks", workflowId);
  const orchestratorDir = join(taskDir, "orchestrator");
  const workerDir = join(taskDir, "workers", "worker-1");
  const verifierDir = join(taskDir, "verifier");
  mkdirSync(workspace, { recursive: true });
  const evidencePath = join(workspace, "verification.txt");
  writeFileSync(evidencePath, "expected output is absent\n", "utf8");
  writeArtifacts(orchestratorDir, "orchestrator");
  writeArtifacts(workerDir, "worker");
  writeArtifacts(verifierDir, "verifier");

  const store = new StateStore(join(stateDir, "controller.sqlite3"));
  store.createWorkflow(
    workflowId,
    "Create and independently verify one output",
    workspace,
    taskDir,
    "orchestrated",
    ["The expected output exists"],
    emptyUsage(),
  );
  const lease = store.claimWorkflow(workflowId, "trace-fixture", 60_000);
  assert.ok(lease);
  store.appendEvent(lease, null, "workflow.started", {
    execution_route: "orchestrated",
  });
  store.createAgentRun(lease, {
    id: "orchestrator-run",
    workflowId,
    parentRunId: null,
    role: "orchestrator",
    profile: "sol_high",
    taskDir: orchestratorDir,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    requestedServiceTier: "priority",
  });
  store.setAgentThread(lease, "orchestrator-run", "orchestrator-thread");
  store.recordAgentProgress(
    lease,
    "orchestrator-run",
    orchestratorUsage,
    "measured",
    "orchestrator.planned",
    { outcome: { status: "ready" } },
  );
  store.recordCheckpoint(
    lease,
    "orchestrator-run",
    "orchestrator.planned",
    "1111111111111111111111111111111111111111",
  );

  store.createAgentRun(lease, {
    id: "worker-run",
    workflowId,
    parentRunId: "orchestrator-run",
    role: "worker",
    profile: "luna_max",
    taskDir: workerDir,
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    requestedServiceTier: "priority",
  });
  store.setAgentThread(lease, "worker-run", "worker-thread");
  store.completeAgentRun(
    lease,
    "worker-run",
    workerUsage,
    "measured",
    "worker.completed",
    {
      outcome: {
        status: "completed",
        summary: "Worker claimed completion",
        result_path: join(workerDir, "result.md"),
        questions: [],
        blocker: null,
      },
    },
    "priority",
  );
  store.recordCheckpoint(
    lease,
    "worker-run",
    "worker.completed",
    "2222222222222222222222222222222222222222",
  );

  store.createAgentRun(lease, {
    id: "verifier-run",
    workflowId,
    parentRunId: "orchestrator-run",
    role: "verifier",
    profile: "terra_high",
    taskDir: verifierDir,
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    requestedServiceTier: "priority",
  });
  store.setAgentThread(lease, "verifier-run", "verifier-thread");
  store.completeAgentRun(
    lease,
    "verifier-run",
    verifierUsage,
    "measured",
    "verifier.completed",
    {
      outcome: {
        status: "findings",
        summary: "Independent verification rejected the result",
        findings: [
          {
            issue: "The expected output is absent",
            evidence: evidencePath,
          },
        ],
        result_path: join(verifierDir, "result.md"),
        questions: [],
        blocker: null,
      },
    },
  );
  store.recordCheckpoint(
    lease,
    "verifier-run",
    "verifier.completed",
    "3333333333333333333333333333333333333333",
  );
  store.finishAgentRun(
    lease,
    "orchestrator-run",
    "completed",
    orchestratorUsage,
    "measured",
  );
  store.finishWorkflow(lease, {
    workflow_id: workflowId,
    status: "failed",
    summary: "Independent verification rejected the result",
    task_dir: taskDir,
    result_path: join(verifierDir, "result.md"),
    questions: [],
    blocker: "The expected output is absent",
    usage: totalUsage(),
    usage_status: "measured",
    execution_route: "orchestrated",
    retry_route: null,
    failure_kind: "verification_rejected",
    recovery_requires_user_approval: false,
  });
  store.close();
  return { root, stateDir, workflowId, evidencePath };
}

function requestWithHost(url: string, host: string): Promise<number> {
  const parsed = new URL(url);
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "GET",
        headers: { host },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolvePromise(response.statusCode ?? 0));
      },
    );
    request.once("error", rejectPromise);
    request.end();
  });
}

test("projects one authoritative Workflow Trace with provenance", (t) => {
  const fixture = createTraceFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));

  const trace = loadWorkflowTrace(fixture.stateDir, fixture.workflowId);
  const latest = loadWorkflowTrace(fixture.stateDir, "latest");
  assert.equal(latest.workflow.id, fixture.workflowId);
  assert.equal(trace.schema_version, "1");
  assert.equal(trace.workflow.status, "failed");
  assert.equal(trace.workflow.failure_kind, "verification_rejected");
  assert.equal(trace.workflow.fast.requested, true);
  assert.equal(trace.workflow.fast.effective, null);
  assert.equal(trace.workflow.usage.status, "measured");
  assert.deepEqual(trace.workflow.usage.value, totalUsage());
  assert.equal(trace.workflow.quota_equivalent.status, "unknown");
  assert.equal(trace.agents.length, 1);
  assert.equal(trace.agents[0]?.role, "orchestrator");
  assert.deepEqual(
    trace.agents[0]?.children.map((agent) => [
      agent.role,
      agent.model,
      agent.reasoning_effort,
    ]),
    [
      ["worker", "gpt-5.6-luna", "max"],
      ["verifier", "gpt-5.6-terra", "high"],
    ],
  );
  assert.equal(trace.agents[0]?.fast.effective_fast, null);
  assert.equal(trace.agents[0]?.children[0]?.fast.effective_fast, true);
  assert.equal(trace.checkpoints.length, 3);
  assert.equal(trace.evidence[0]?.artifact_path, fixture.evidencePath);
  assert.equal(
    trace.artifacts.some(
      (item) => item.kind === "evidence" && item.path === fixture.evidencePath,
    ),
    true,
  );
  const formatted = formatWorkflowTrace(trace);
  assert.match(formatted, /gpt-5\.6-luna; effort: max/);
  assert.match(formatted, /effective=unknown/);
  assert.match(formatted, /Quota equivalent: unknown/);
  assert.match(formatted, /The expected output is absent/);
});

test("CLI text and JSON consume the same Workflow Trace projection", (t) => {
  const fixture = createTraceFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const env = {
    ...process.env,
    AGENT_WORKFLOW_STATE_DIR: fixture.stateDir,
  };

  const json = JSON.parse(
    execFileSync(
      process.execPath,
      [cliPath, "trace", "--json", fixture.workflowId],
      { encoding: "utf8", env },
    ),
  ) as ReturnType<typeof loadWorkflowTrace>;
  const text = execFileSync(
    process.execPath,
    [cliPath, "trace", "latest"],
    { encoding: "utf8", env },
  );

  assert.equal(json.workflow.id, fixture.workflowId);
  assert.equal(json.workflow.fast.effective, null);
  assert.equal(json.workflow.quota_equivalent.status, "unknown");
  assert.match(text, new RegExp(fixture.workflowId));
  assert.match(text, /gpt-5\.6-luna/);
  assert.match(text, /Usage: measured/);
  assert.match(text, /Quota equivalent: unknown/);
});

test("CLI reports an empty fresh state directory without a SQLite error", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-empty-trace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, "trace", "latest"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_WORKFLOW_STATE_DIR: join(root, "state"),
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "No workflows are stored\n");
});

test("loads a legacy Workflow Trace without migrating its read-only database", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-legacy-trace-"));
  const stateDir = join(root, "state");
  const databasePath = join(stateDir, "controller.sqlite3");
  const workflowId = "00000000-0000-4000-8000-000000000102";
  const taskDir = join(stateDir, "tasks", workflowId);
  const workerDir = join(taskDir, "workers", "worker-1");
  mkdirSync(workerDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      request TEXT NOT NULL,
      workspace TEXT NOT NULL,
      task_dir TEXT NOT NULL,
      execution_route TEXT NOT NULL DEFAULT 'orchestrated',
      completion_criteria_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      summary TEXT,
      result_path TEXT,
      questions_json TEXT NOT NULL DEFAULT '[]',
      blocker TEXT,
      usage_json TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      parent_run_id TEXT REFERENCES agent_runs(id),
      role TEXT NOT NULL,
      profile TEXT NOT NULL,
      task_dir TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      usage_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      run_id TEXT REFERENCES agent_runs(id),
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE checkpoints (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      run_id TEXT REFERENCES agent_runs(id),
      kind TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  legacy.prepare(`
    INSERT INTO workflows (
      id, request, workspace, task_dir, execution_route,
      completion_criteria_json, status, summary, questions_json,
      usage_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'orchestrated', '[]', 'completed', ?, '[]', ?, ?, ?)
  `).run(
    workflowId,
    "Read a legacy trace",
    join(root, "workspace"),
    taskDir,
    "Legacy workflow completed",
    JSON.stringify(workerUsage),
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:01:00.000Z",
  );
  legacy.prepare(`
    INSERT INTO agent_runs (
      id, workflow_id, parent_run_id, role, profile, task_dir,
      thread_id, status, usage_json, error, started_at, completed_at
    ) VALUES (?, ?, NULL, 'worker', 'luna_max', ?, NULL, 'completed', ?, NULL, ?, ?)
  `).run(
    "legacy-worker",
    workflowId,
    workerDir,
    JSON.stringify(workerUsage),
    "2026-08-01T00:00:00.000Z",
    "2026-08-01T00:01:00.000Z",
  );
  legacy.close();

  const columns = (table: string): string[] => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return (
        database.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[]
      ).map((column) => column.name);
    } finally {
      database.close();
    }
  };
  const workflowColumnsBefore = columns("workflows");
  const agentRunColumnsBefore = columns("agent_runs");
  const databaseBefore = readFileSync(databasePath);

  const trace = loadWorkflowTrace(stateDir, workflowId);

  assert.equal(trace.workflow.id, workflowId);
  assert.equal(trace.workflow.usage.status, "unknown");
  assert.equal(trace.workflow.usage.source, null);
  assert.equal(trace.workflow.failure_kind, null);
  assert.equal(trace.workflow.recovery_requires_user_approval, false);
  assert.equal(trace.agents[0]?.profile, "luna_max");
  assert.equal(trace.agents[0]?.model, "gpt-5.6-luna");
  assert.equal(trace.agents[0]?.reasoning_effort, "max");
  assert.equal(trace.agents[0]?.fast.requested_service_tier, "default");
  assert.equal(trace.agents[0]?.fast.effective_service_tier, null);
  assert.equal(trace.agents[0]?.usage.status, "unknown");
  assert.equal(trace.agents[0]?.usage.source, null);
  assert.equal(trace.agents[0]?.error_kind, null);
  assert.deepEqual(columns("workflows"), workflowColumnsBefore);
  assert.deepEqual(columns("agent_runs"), agentRunColumnsBefore);
  assert.deepEqual(readFileSync(databasePath), databaseBefore);
});

test("read-only Web viewer stays on loopback and does not follow artifact symlinks", async (t) => {
  const fixture = createTraceFixture();
  const store = new StateStore(join(fixture.stateDir, "controller.sqlite3"), {
    readOnly: true,
  });
  const trace = buildWorkflowTrace(store, fixture.workflowId);
  store.close();
  const viewer = await startTraceWebViewer({ load: () => trace });
  t.after(async () => {
    await viewer.close().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  const api = await fetch(`${viewer.url}api/trace`, { cache: "no-store" });
  assert.equal(api.status, 200);
  const projected = (await api.json()) as ReturnType<typeof loadWorkflowTrace>;
  assert.equal(projected.workflow.id, fixture.workflowId);
  assert.equal(projected.revision, trace.revision);
  const page = await fetch(viewer.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Workflow Trace/);
  assert.equal(await requestWithHost(viewer.url, "evil.example"), 421);

  const artifactIndex = trace.artifacts.findIndex(
    (item) => item.path === fixture.evidencePath,
  );
  assert.ok(artifactIndex >= 0);
  const artifactResponse = await fetch(
    `${viewer.url}artifact?index=${artifactIndex}`,
  );
  assert.equal(artifactResponse.status, 200);
  assert.equal(await artifactResponse.text(), "expected output is absent\n");

  const external = join(fixture.root, "external-secret.txt");
  writeFileSync(external, "must not be served\n", "utf8");
  rmSync(fixture.evidencePath);
  symlinkSync(external, fixture.evidencePath);
  const replaced = await fetch(
    `${viewer.url}artifact?index=${artifactIndex}`,
  );
  assert.equal(replaced.status, 409);
  assert.doesNotMatch(await replaced.text(), /must not be served/);
  assert.equal(readFileSync(external, "utf8"), "must not be served\n");
});
