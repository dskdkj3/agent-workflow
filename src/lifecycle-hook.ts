#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CheckpointRepository } from "./checkpoints.js";
import { StateStore } from "./state.js";

export interface LifecycleHookMetadata {
  workflow_id: string;
  run_id: string;
  task_path: string;
  journal_path: string;
  state_database: string;
  checkpoint_work_tree: string;
  checkpoint_git_dir: string;
  git_path?: string;
}

export function writeLifecycleHookMetadata(
  path: string,
  metadata: LifecycleHookMetadata,
): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

interface HookInput {
  hook_event_name: "PreCompact" | "SessionStart";
  source?: string;
  trigger?: string;
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function readMetadata(path: string): LifecycleHookMetadata {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as LifecycleHookMetadata;
}

function checkpoint(metadata: LifecycleHookMetadata): void {
  const repository = new CheckpointRepository({
    workTree: metadata.checkpoint_work_tree,
    gitDir: metadata.checkpoint_git_dir,
    ...(metadata.git_path ? { gitPath: metadata.git_path } : {}),
  });
  const checkpointCommit = repository.commit("journal.pre_compact", {
    includeNewResults: false,
  });
  const store = new StateStore(metadata.state_database);
  try {
    store.recordCheckpoint(
      metadata.workflow_id,
      metadata.run_id,
      checkpointCommit.kind,
      checkpointCommit.id,
    );
    store.appendEvent(
      metadata.workflow_id,
      metadata.run_id,
      "journal.pre_compact",
      {
        commit_id: checkpointCommit.id,
      },
    );
  } finally {
    store.close();
  }
}

function compactContext(metadata: LifecycleHookMetadata): string {
  const task = readFileSync(metadata.task_path, "utf8");
  const journal = readFileSync(metadata.journal_path, "utf8");
  return (
    "The conversation was compacted. Reload the complete durable task and " +
    "narrative journal below before continuing. The Codex core has already " +
    "reconstructed the active user-level and project-level AGENTS.md " +
    "instructions; do not treat this hook context as a replacement for them.\n\n" +
    `## Complete task.md\n\n${task}\n\n` +
    `## Complete journal.md\n\n${journal}`
  );
}

export function handleLifecycleHook(
  metadata: LifecycleHookMetadata,
  input: HookInput,
): Record<string, unknown> {
  if (input.hook_event_name === "PreCompact") {
    checkpoint(metadata);
    return { continue: true, suppressOutput: true };
  }
  if (input.hook_event_name === "SessionStart" && input.source === "compact") {
    return {
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: compactContext(metadata),
      },
    };
  }
  return { continue: true, suppressOutput: true };
}

function main(): void {
  let input: HookInput | null = null;
  try {
    const metadataPath = process.argv[2];
    if (metadataPath === undefined) {
      throw new Error("Lifecycle hook metadata path is required");
    }
    input = JSON.parse(readStdin()) as HookInput;
    const output = handleLifecycleHook(readMetadata(metadataPath), input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const message = `Agent Workflow lifecycle hook failed: ${String(error)}`;
    process.stdout.write(
      `${JSON.stringify({ continue: false, stopReason: message })}\n`,
    );
    process.exitCode = 0;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath !== null && fileURLToPath(import.meta.url) === entryPath) {
  main();
}
