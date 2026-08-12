import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CheckpointRepository } from "./checkpoints.js";

test("preserves semantic journal versions and rejects frozen-file rewrites", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-checkpoints-"));
  const workTree = join(root, "task");
  const agentDir = join(workTree, "orchestrator");
  mkdirSync(agentDir, { recursive: true });
  const taskPath = join(agentDir, "task.md");
  const journalPath = join(agentDir, "journal.md");
  writeFileSync(taskPath, "# Task\n\nOriginal objective\n", "utf8");
  chmodSync(taskPath, 0o444);
  writeFileSync(journalPath, "# Journal\n\nFirst understanding\n", "utf8");

  const repository = new CheckpointRepository({
    workTree,
    gitDir: join(root, "history.git"),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = repository.commit("workflow.accepted");
  writeFileSync(journalPath, "# Journal\n\nRevised understanding\n", "utf8");
  const second = repository.commit("orchestrator.planned");

  assert.match(
    repository.readFileAt(first.id, "orchestrator/journal.md"),
    /First understanding/,
  );
  assert.match(
    repository.readFileAt(second.id, "orchestrator/journal.md"),
    /Revised understanding/,
  );

  chmodSync(taskPath, 0o644);
  writeFileSync(taskPath, "# Task\n\nSilently changed objective\n", "utf8");
  assert.throws(
    () => repository.commit("orchestrator.rewritten"),
    /Frozen checkpoint file was modified/,
  );
});
