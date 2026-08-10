import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { AgentOutcome, AgentRole } from "./contracts.js";

export interface AgentJournalPaths {
  directory: string;
  task: string;
  journal: string;
  result: string;
}

interface CreateAgentJournalOptions {
  directory: string;
  role: AgentRole;
  workflowId: string;
  workspace: string;
  objective: string;
  completionCriteria: string[];
}

function markdownList(items: string[]): string {
  return items.length === 0 ? "- None specified" : items.map((item) => `- ${item}`).join("\n");
}

export function createAgentJournal(
  options: CreateAgentJournalOptions,
): AgentJournalPaths {
  mkdirSync(options.directory, { recursive: true });
  const paths: AgentJournalPaths = {
    directory: options.directory,
    task: join(options.directory, "task.md"),
    journal: join(options.directory, "journal.md"),
    result: join(options.directory, "result.md"),
  };

  writeFileSync(
    paths.task,
    `# Task\n\n` +
      `- Workflow: \`${options.workflowId}\`\n` +
      `- Role: \`${options.role}\`\n` +
      `- Workspace: \`${options.workspace}\`\n\n` +
      `## Objective\n\n${options.objective}\n\n` +
      `## Completion criteria\n\n${markdownList(options.completionCriteria)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  chmodSync(paths.task, 0o444);

  writeFileSync(
    paths.journal,
    `# Journal\n\n` +
      `Current status: task created; execution has not started.\n\n` +
      `Last updated: ${new Date().toISOString()}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  return paths;
}

export function ensureFrozenResult(
  path: string,
  role: AgentRole,
  outcome: AgentOutcome,
): void {
  if (!existsSync(path)) {
    const questions = markdownList(outcome.questions);
    writeFileSync(
      path,
      `# Result\n\n` +
        `- Role: \`${role}\`\n` +
        `- Status: \`${outcome.status}\`\n\n` +
        `## Summary\n\n${outcome.summary}\n\n` +
        `## Questions\n\n${questions}\n\n` +
        `## Blocker\n\n${outcome.blocker ?? "None"}\n`,
      "utf8",
    );
  }
  chmodSync(path, 0o444);
}

export function ensureFrozenFailureResult(path: string, message: string): void {
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `# Result\n\n- Status: \`failed\`\n\n## Failure\n\n${message}\n`,
      "utf8",
    );
  }
  chmodSync(path, 0o444);
}
