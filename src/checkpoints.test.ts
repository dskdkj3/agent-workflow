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
import { emptyUsage } from "./contracts.js";
import { StateStore } from "./state.js";

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

test("finds checkpoints only from the requested lease epoch", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-epoch-"));
  const workTree = join(root, "task");
  const agentDir = join(workTree, "orchestrator");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "task.md"), "# Task\n\nEpoch test\n", "utf8");
  writeFileSync(join(agentDir, "journal.md"), "# Journal\n\nEpoch one\n", "utf8");
  const repository = new CheckpointRepository({
    workTree,
    gitDir: join(root, "history.git"),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = repository.commit("worker.completed", { leaseEpoch: 1 });
  writeFileSync(join(agentDir, "journal.md"), "# Journal\n\nEpoch two\n", "utf8");
  const second = repository.commit("worker.completed", { leaseEpoch: 2 });

  assert.deepEqual(repository.findCommit("worker.completed", 1), first);
  assert.deepEqual(repository.findCommit("worker.completed", 2), second);
  assert.equal(repository.findCommit("worker.completed", 3), null);
});

test("keeps a commit from a superseded lease non-authoritative", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-checkpoint-takeover-"));
  const workTree = join(root, "task");
  const agentDir = join(workTree, "workers", "worker-1");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "task.md"), "# Task\n\nTakeover test\n", "utf8");
  writeFileSync(join(agentDir, "journal.md"), "# Journal\n\nOld epoch\n", "utf8");
  const workflowId = "00000000-0000-4000-8000-000000000061";
  const store = new StateStore(join(root, "controller.sqlite3"));
  store.createWorkflow(
    workflowId,
    "Define checkpoint takeover authority",
    root,
    workTree,
    "single_worker",
    ["Only the current lease checkpoint is authoritative"],
    emptyUsage(),
  );
  const oldLease = store.claimWorkflow(workflowId, "old-owner", 60_000);
  assert.ok(oldLease);
  store.createAgentRun(oldLease, {
    id: "takeover-worker",
    workflowId,
    parentRunId: null,
    role: "worker",
    profile: "luna_high",
    taskDir: agentDir,
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    requestedServiceTier: "default",
  });
  const repository = new CheckpointRepository({
    workTree,
    gitDir: join(root, "history.git"),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const staleCommit = repository.commit("worker.completed", {
    leaseEpoch: oldLease.epoch,
  });
  store.database
    .prepare("UPDATE workflows SET lease_expires_at = ? WHERE id = ?")
    .run("1970-01-01T00:00:00.000Z", workflowId);
  const currentLease = store.claimWorkflow(workflowId, "current-owner", 60_000);
  assert.ok(currentLease);
  assert.throws(
    () =>
      store.recordCheckpoint(
        oldLease,
        "takeover-worker",
        staleCommit.kind,
        staleCommit.id,
      ),
    /lease was lost/,
  );

  writeFileSync(join(agentDir, "journal.md"), "# Journal\n\nCurrent epoch\n", "utf8");
  const currentCommit = repository.commit("worker.completed", {
    leaseEpoch: currentLease.epoch,
  });
  store.recordCheckpoint(
    currentLease,
    "takeover-worker",
    currentCommit.kind,
    currentCommit.id,
  );

  assert.deepEqual(
    store.listStoredCheckpoints(workflowId).map((item) => item.commitId),
    [currentCommit.id],
  );
  assert.deepEqual(
    repository.findCommit("worker.completed", oldLease.epoch),
    staleCommit,
  );
  assert.deepEqual(
    repository.findCommit("worker.completed", currentLease.epoch),
    currentCommit,
  );
});
