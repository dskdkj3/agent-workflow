import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CheckpointRepository } from "./checkpoints.js";
import { prepareAgentCodexHome, readAgentCodexConfig } from "./codex-home.js";
import { emptyUsage } from "./contracts.js";
import {
  handleLifecycleHook,
  type LifecycleHookMetadata,
} from "./lifecycle-hook.js";
import { StateStore } from "./state.js";

function fixture(): {
  root: string;
  workflowId: string;
  runId: string;
  taskPath: string;
  journalPath: string;
  resultPath: string;
  metadata: LifecycleHookMetadata;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-hook-"));
  const workflowId = "00000000-0000-4000-8000-000000000011";
  const runId = "hook-run";
  const workTree = join(root, "task");
  const agentDir = join(workTree, "workers", "worker-1");
  mkdirSync(agentDir, { recursive: true });
  const taskPath = join(agentDir, "task.md");
  const journalPath = join(agentDir, "journal.md");
  const resultPath = join(agentDir, "result.md");
  writeFileSync(taskPath, "# Task\n\nComplete durable task text\n", "utf8");
  chmodSync(taskPath, 0o444);
  writeFileSync(
    journalPath,
    "# Journal\n\nComplete durable journal text\n",
    "utf8",
  );
  writeFileSync(resultPath, "# Result\n\nIncomplete result\n", "utf8");
  const databasePath = join(root, "controller.sqlite3");
  const store = new StateStore(databasePath);
  store.createWorkflow(
    workflowId,
    "Exercise compact hooks",
    root,
    workTree,
    "single_worker",
    ["Durable content is recoverable"],
    emptyUsage(),
  );
  store.createAgentRun({
    id: runId,
    workflowId,
    parentRunId: null,
    role: "worker",
    profile: "luna_max",
    taskDir: agentDir,
  });
  store.close();
  return {
    root,
    workflowId,
    runId,
    taskPath,
    journalPath,
    resultPath,
    metadata: {
      workflow_id: workflowId,
      run_id: runId,
      task_path: taskPath,
      journal_path: journalPath,
      state_database: databasePath,
      checkpoint_work_tree: workTree,
      checkpoint_git_dir: join(root, "checkpoint.git"),
    },
  };
}

test("PreCompact checkpoints the latest Journal without an unfinished result", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));

  const output = handleLifecycleHook(current.metadata, {
    hook_event_name: "PreCompact",
    trigger: "auto",
  });
  assert.deepEqual(output, { continue: true, suppressOutput: true });
  const store = new StateStore(current.metadata.state_database);
  const checkpoints = store.listCheckpoints(current.workflowId);
  store.close();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.kind, "journal.pre_compact");
  const commitId = String(checkpoints[0]?.commit_id);
  const repositoryConfig = join(current.metadata.checkpoint_git_dir, "config");
  assert.match(readFileSync(repositoryConfig, "utf8"), /bare = true/);
  const repository = new CheckpointRepository({
    workTree: current.metadata.checkpoint_work_tree,
    gitDir: current.metadata.checkpoint_git_dir,
  });
  assert.match(
    repository.readFileAt(commitId, "workers/worker-1/journal.md"),
    /Complete durable journal text/,
  );
  assert.match(
    repository.readFileAt(commitId, "workers/worker-1/task.md"),
    /Complete durable task text/,
  );
  assert.equal(
    repository.hasFileAt(commitId, "workers/worker-1/result.md"),
    false,
  );
});

test("compact SessionStart injects complete Task and Journal without duplicating AGENTS", (t) => {
  const current = fixture();
  t.after(() => rmSync(current.root, { recursive: true, force: true }));

  const output = handleLifecycleHook(current.metadata, {
    hook_event_name: "SessionStart",
    source: "compact",
  });
  const context = String(
    (output.hookSpecificOutput as { additionalContext: string })
      .additionalContext,
  );
  assert.match(context, /Complete durable task text/);
  assert.match(context, /Complete durable journal text/);
  assert.match(context, /AGENTS\.md instructions/);
  assert.doesNotMatch(context, /# Agent Onboarding/);
});

test("isolated CODEX_HOME falls back to durable user instructions and auth", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-codex-home-"));
  const parent = join(root, "ephemeral-parent");
  const user = join(root, "durable-user");
  const codexHome = join(root, "agent-home");
  mkdirSync(parent, { recursive: true });
  mkdirSync(user, { recursive: true });
  writeFileSync(join(user, "AGENTS.md"), "# Durable user instructions\n", "utf8");
  writeFileSync(join(user, "auth.json"), "{}\n", "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  prepareAgentCodexHome({
    codexHome,
    parentCodexHome: parent,
    userCodexHome: user,
    metadataPath: join(codexHome, "workflow-hook.json"),
  });
  assert.equal(
    readFileSync(join(codexHome, "AGENTS.md"), "utf8"),
    "# Durable user instructions\n",
  );
  assert.equal(
    realpathSync(join(codexHome, "auth.json")),
    realpathSync(join(user, "auth.json")),
  );
  const config = readAgentCodexConfig(codexHome);
  assert.match(config, /\[\[hooks\.PreCompact\]\]/);
  assert.match(config, /\[\[hooks\.SessionStart\]\]/);
  assert.match(config, /additionalContextLimit = 0/);
  assert.doesNotMatch(config, /bypass_hook_trust/);
  assert.equal((config.match(/trusted_hash = "sha256:/g) ?? []).length, 2);
});
