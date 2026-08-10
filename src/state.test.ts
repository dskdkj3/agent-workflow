import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { StateStore } from "./state.js";

test("migrates legacy agent runs to the historical sol_high profile", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-state-"));
  const databasePath = join(root, "controller.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
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
});
