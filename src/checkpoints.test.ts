import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
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
  assert.deepEqual(repository.findCommit("workflow.accepted"), first);
  assert.deepEqual(repository.latestCommit(), second);

  chmodSync(taskPath, 0o644);
  writeFileSync(taskPath, "# Task\n\nSilently changed objective\n", "utf8");
  assert.throws(
    () => repository.commit("orchestrator.rewritten"),
    /Frozen checkpoint file was modified/,
  );
});

test("pre-compaction checkpoint omits a newly written unfinished result", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-precompact-"));
  const workTree = join(root, "task");
  const agentDir = join(workTree, "workers", "worker-1");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "task.md"), "# Task\n\nBounded task\n", "utf8");
  chmodSync(join(agentDir, "task.md"), 0o444);
  writeFileSync(
    join(agentDir, "journal.md"),
    "# Journal\n\nLatest durable progress\n",
    "utf8",
  );
  writeFileSync(
    join(agentDir, "result.md"),
    "# Result\n\nThis turn has not completed\n",
    "utf8",
  );
  const repository = new CheckpointRepository({
    workTree,
    gitDir: join(root, "history.git"),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const checkpoint = repository.commit("journal.pre_compact", {
    includeNewResults: false,
  });
  assert.match(
    repository.readFileAt(checkpoint.id, "workers/worker-1/journal.md"),
    /Latest durable progress/,
  );
  assert.match(
    repository.readFileAt(checkpoint.id, "workers/worker-1/task.md"),
    /Bounded task/,
  );
  assert.equal(existsSync(join(agentDir, "result.md")), true);
  assert.equal(
    repository.hasFileAt(checkpoint.id, "workers/worker-1/result.md"),
    false,
  );
});
