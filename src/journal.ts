import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import type {
  AgentRole,
  VerificationEvidenceReference,
  VerificationOutcome,
} from "./contracts.js";

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

interface JournalOutcome {
  status: string;
  summary: string;
  questions: string[];
  blocker: string | null;
}

interface ResultMaterializationOptions {
  preserveExisting?: boolean;
  acceptFinalized?: boolean;
  evidenceReferences?: VerificationEvidenceReference[];
}

const CONTROLLER_RESULT_MARKER = "agent-workflow-controller-result:v1";

function markdownList(items: string[]): string {
  return items.length === 0 ? "- None specified" : items.map((item) => `- ${item}`).join("\n");
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function openRegularFile(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`Artifact is not a regular file: ${path}`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readRegularFile(path: string): string {
  const fd = openRegularFile(path, constants.O_RDONLY);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function createRegularFile(path: string, content: string, mode: number): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function replaceRegularFile(
  path: string,
  content: string,
  mode: number,
): void {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    createRegularFile(temporary, content, 0o600);
    renameSync(temporary, path);
    const fd = openRegularFile(path, constants.O_RDONLY);
    try {
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } finally {
    if (pathEntryExists(temporary)) {
      unlinkSync(temporary);
    }
  }
}

function resultSignature(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function existingAgentReport(
  path: string,
  expectedSignature: string,
  preserveExisting: boolean,
  acceptFinalized: boolean,
): { finalized: boolean; report: string | null } {
  if (!pathEntryExists(path)) {
    return { finalized: false, report: null };
  }
  if (!preserveExisting) {
    return { finalized: false, report: null };
  }

  const content = readRegularFile(path);
  const marker = content.match(
    /<!-- agent-workflow-controller-result:v1:([0-9a-f]{64}) -->/,
  );
  if (marker !== null && acceptFinalized) {
    if (marker[1] !== expectedSignature) {
      throw new Error(`Final result differs from its structured outcome: ${path}`);
    }
    return { finalized: true, report: null };
  }
  const report = content.trim();
  return { finalized: false, report: report === "" ? null : report };
}

function evidenceList(references: VerificationEvidenceReference[]): string {
  return references.length === 0
    ? "- None"
    : references
        .map(
          (reference) =>
            `- ${reference.claim}\n  - Artifact: \`${reference.artifact_path}\``,
        )
        .join("\n");
}

function agentReportSection(report: string | null): string {
  return report === null
    ? ""
    : `\n\n## Agent-authored report\n\n${report}\n`;
}

const INITIAL_JOURNAL_STATUS =
  "Current status: task created; execution has not started.";

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

  const taskContent =
    `# Task\n\n` +
    `- Workflow: \`${options.workflowId}\`\n` +
    `- Role: \`${options.role}\`\n` +
    `- Workspace: \`${options.workspace}\`\n\n` +
    `## Objective\n\n${options.objective}\n\n` +
    `## Completion criteria\n\n${markdownList(options.completionCriteria)}\n`;

  if (!pathEntryExists(paths.task)) {
    createRegularFile(paths.task, taskContent, 0o444);
  } else if (readRegularFile(paths.task) !== taskContent) {
    throw new Error(`Frozen task artifact differs from its accepted request: ${paths.task}`);
  }
  const taskFd = openRegularFile(paths.task, constants.O_RDONLY);
  try {
    fchmodSync(taskFd, 0o444);
  } finally {
    closeSync(taskFd);
  }

  if (!pathEntryExists(paths.journal)) {
    createRegularFile(
      paths.journal,
      `# Journal\n\n` +
        `${INITIAL_JOURNAL_STATUS}\n\n` +
        `Last updated: ${new Date().toISOString()}\n`,
      0o600,
    );
  } else {
    const journalFd = openRegularFile(paths.journal, constants.O_RDWR);
    closeSync(journalFd);
  }

  return paths;
}

export function restoreAgentJournal(
  paths: AgentJournalPaths,
  task: string,
  journal: string,
): void {
  replaceRegularFile(paths.task, task, 0o444);
  replaceRegularFile(paths.journal, journal, 0o600);
}

export function prepareResultForTurn(path: string): void {
  if (!pathEntryExists(path)) {
    return;
  }
  const entry = lstatSync(path);
  if (entry.isDirectory()) {
    throw new Error(`Result artifact is a directory: ${path}`);
  }
  unlinkSync(path);
}

export function ensureStructuredJournal(
  path: string,
  outcome: JournalOutcome,
): void {
  const current = readRegularFile(path);
  if (!current.includes(INITIAL_JOURNAL_STATUS)) {
    return;
  }

  replaceRegularFile(
    path,
    `# Journal\n\n` +
      `Current status: ${outcome.status}.\n\n` +
      `## Summary\n\n${outcome.summary}\n\n` +
      `## Questions\n\n${markdownList(outcome.questions)}\n\n` +
      `## Blocker\n\n${outcome.blocker ?? "None"}\n\n` +
      `Last updated: ${new Date().toISOString()}\n`,
    0o600,
  );
}

export function ensureFrozenResult(
  path: string,
  role: AgentRole,
  outcome: JournalOutcome,
): void {
  ensureResult(path, role, outcome);
  freezeResult(path);
}

export function ensureResult(
  path: string,
  role: AgentRole,
  outcome: JournalOutcome,
  options: ResultMaterializationOptions = {},
): void {
  const evidenceReferences = options.evidenceReferences ?? [];
  const signature = resultSignature({ role, outcome, evidenceReferences });
  const existing = existingAgentReport(
    path,
    signature,
    options.preserveExisting === true,
    options.acceptFinalized === true,
  );
  if (existing.finalized) {
    return;
  }
  const questions = markdownList(outcome.questions);
  replaceRegularFile(
    path,
    `<!-- ${CONTROLLER_RESULT_MARKER}:${signature} -->\n` +
      `# Result\n\n` +
      `- Role: \`${role}\`\n` +
      `- Status: \`${outcome.status}\`\n\n` +
      `## Summary\n\n${outcome.summary}\n\n` +
      `## Questions\n\n${questions}\n\n` +
      `## Blocker\n\n${outcome.blocker ?? "None"}\n\n` +
      `## Evidence references\n\n${evidenceList(evidenceReferences)}\n` +
      agentReportSection(existing.report),
    0o444,
  );
}

export function ensureFrozenFailureResult(path: string, message: string): void {
  ensureFailureResult(path, message);
  freezeResult(path);
}

export function ensureFailureResult(path: string, message: string): void {
  replaceRegularFile(
    path,
    `# Result\n\n- Status: \`failed\`\n\n## Failure\n\n${message}\n`,
    0o444,
  );
}

export function ensureFrozenVerificationResult(
  path: string,
  outcome: VerificationOutcome,
): void {
  ensureVerificationResult(path, outcome);
  freezeResult(path);
}

export function ensureVerificationResult(
  path: string,
  outcome: VerificationOutcome,
  options: ResultMaterializationOptions = {},
): void {
  const signature = resultSignature({ role: "verifier", outcome });
  const existing = existingAgentReport(
    path,
    signature,
    options.preserveExisting === true,
    options.acceptFinalized === true,
  );
  if (existing.finalized) {
    return;
  }
  const findings =
    outcome.findings.length === 0
      ? "- None"
      : outcome.findings
          .map(
            (finding) =>
              `- ${finding.issue}\n  - Evidence: ${finding.evidence}`,
          )
          .join("\n");
  replaceRegularFile(
    path,
    `<!-- ${CONTROLLER_RESULT_MARKER}:${signature} -->\n` +
      `# Result\n\n` +
      `- Role: \`verifier\`\n` +
      `- Status: \`${outcome.status}\`\n\n` +
      `## Summary\n\n${outcome.summary}\n\n` +
      `## Findings\n\n${findings}\n\n` +
      `## Evidence references\n\n${evidenceList(outcome.evidence_references)}\n\n` +
      `## Questions\n\n${markdownList(outcome.questions)}\n\n` +
      `## Blocker\n\n${outcome.blocker ?? "None"}\n` +
      agentReportSection(existing.report),
    0o444,
  );
}

export function freezeResult(path: string): void {
  const fd = openRegularFile(path, constants.O_RDONLY);
  try {
    fchmodSync(fd, 0o444);
  } finally {
    closeSync(fd);
  }
}
