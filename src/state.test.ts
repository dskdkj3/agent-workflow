import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { emptyUsage, type WorkflowRunOutput } from "./contracts.js";
import { StateStore, WorkflowLeaseLostError } from "./state.js";

test("an expired owner can renew only until another Controller takes over", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-lease-renewal-"));
  const store = new StateStore(join(root, "controller.sqlite3"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const workflowId = "00000000-0000-4000-8000-000000000010";
  store.createWorkflow(
    workflowId,
    "Exercise lease renewal",
    "/tmp/workspace",
    "/tmp/task",
    "orchestrated",
    [],
    emptyUsage(),
  );
  const first = store.claimWorkflow(workflowId, "owner-a", 60_000);
  assert.ok(first);
  store.database
    .prepare("UPDATE workflows SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", workflowId);

  assert.equal(store.heartbeatWorkflow(first, 60_000), true);
  store.assertWorkflowLease(first);

  store.database
    .prepare("UPDATE workflows SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", workflowId);
  const second = store.claimWorkflow(workflowId, "owner-b", 60_000);
  assert.ok(second);
  assert.equal(second.epoch, first.epoch + 1);
  assert.equal(store.heartbeatWorkflow(first, 60_000), false);
  assert.throws(
    () => store.assertWorkflowLease(first),
    WorkflowLeaseLostError,
  );
  store.assertWorkflowLease(second);
});

test("migrates legacy agent runs to the historical sol_high profile", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-state-"));
  const databasePath = join(root, "controller.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      request TEXT NOT NULL,
      workspace TEXT NOT NULL,
      task_dir TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      result_path TEXT,
      questions_json TEXT NOT NULL DEFAULT '[]',
      blocker TEXT,
      usage_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      parent_run_id TEXT,
      role TEXT NOT NULL,
      task_dir TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      usage_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    INSERT INTO agent_runs (
      id, workflow_id, parent_run_id, role, task_dir, status, started_at
    ) VALUES (
      'legacy-run', 'legacy-workflow', NULL, 'worker', '/tmp/legacy',
      'completed', '2026-01-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const store = new StateStore(databasePath);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const row = store.database
    .prepare("SELECT profile FROM agent_runs WHERE id = 'legacy-run'")
    .get() as { profile: string };
  assert.equal(row.profile, "sol_high");

  const column = store.database
    .prepare("PRAGMA table_info(agent_runs)")
    .all()
    .find((candidate) => candidate.name === "profile") as
    | { notnull: number; dflt_value: string | null }
    | undefined;
  assert.ok(column);
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, "'sol_high'");

  const workflowRouteColumn = store.database
    .prepare("PRAGMA table_info(workflows)")
    .all()
    .find((candidate) => candidate.name === "execution_route") as
    | { notnull: number; dflt_value: string | null }
    | undefined;
  assert.ok(workflowRouteColumn);
  assert.equal(workflowRouteColumn.notnull, 1);
  assert.equal(workflowRouteColumn.dflt_value, "'orchestrated'");

  const workflowColumns = new Set(
    (store.database.prepare("PRAGMA table_info(workflows)").all() as {
      name: string;
    }[]).map((candidate) => candidate.name),
  );
  assert.equal(workflowColumns.has("completion_criteria_json"), true);
  assert.equal(workflowColumns.has("lease_owner"), true);
  assert.equal(workflowColumns.has("lease_expires_at"), true);
});

test("stores exactly one terminal outcome and matching terminal event", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-terminal-"));
  const store = new StateStore(join(root, "controller.sqlite3"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const workflowId = "00000000-0000-4000-8000-000000000001";
  const usage = emptyUsage();
  store.createWorkflow(
    workflowId,
    "Complete one task",
    "/tmp/workspace",
    "/tmp/task",
    "orchestrated",
    [],
    usage,
  );
  const lease = store.claimWorkflow(workflowId, "terminal-test", 60_000);
  assert.ok(lease);
  const completed: WorkflowRunOutput = {
    workflow_id: workflowId,
    status: "completed",
    summary: "The task is complete",
    task_dir: "/tmp/task",
    result_path: "/tmp/task/orchestrator/result.md",
    questions: [],
    blocker: null,
    usage,
    usage_status: "measured",
    execution_route: "orchestrated",
    retry_route: null,
    failure_kind: null,
    recovery_requires_user_approval: false,
  };
  store.finishWorkflow(lease, completed);

  const competingFailure: WorkflowRunOutput = {
    ...completed,
    status: "failed",
    summary: "A late failure tried to replace completion",
    blocker: "late failure",
    failure_kind: "execution_error",
  };
  assert.throws(
    () => store.finishWorkflow(lease, competingFailure),
    /Controller lease was lost/,
  );
  assert.equal(store.getWorkflow(workflowId)?.status, "completed");

  const terminalEvents = store.database
    .prepare(
      "SELECT payload_json FROM events WHERE workflow_id = ? AND type = 'workflow.terminal'",
    )
    .all(workflowId) as { payload_json: string }[];
  assert.equal(terminalEvents.length, 1);
  assert.equal(
    JSON.parse(terminalEvents[0]?.payload_json ?? "{}").status,
    "completed",
  );
});
