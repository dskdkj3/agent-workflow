import type { AgentJournalPaths } from "./journal.js";

interface RecoveryPromptOptions {
  workspace: string;
  journal: AgentJournalPaths;
}

export function recoverOrchestratorPlanningPrompt(
  options: RecoveryPromptOptions,
): string {
  return `The Workflow Controller process was interrupted while your planning turn was active.

Reload the complete durable task and journal:
${options.journal.task}
${options.journal.journal}

Reinspect the current Workspace before acting because it may contain partial work from the interrupted turn:
${options.workspace}

Continue the same planning responsibility. Do not implement the requested change and do not create agents. Preserve valid prior decisions, correct stale journal claims, and return only the structured orchestration plan required by the schema.`;
}

export function recoverWorkerPrompt(options: RecoveryPromptOptions): string {
  return `The Workflow Controller process was interrupted while your Worker turn was active.

Reload the complete durable task and journal:
${options.journal.task}
${options.journal.journal}

Reinspect the current Workspace before continuing because commands or edits from the interrupted turn may already have taken effect:
${options.workspace}

Continue from the current state. Do not blindly repeat side effects. Update the journal when state, evidence, or the next step changes, write the final self-contained result to ${options.journal.result}, and return only the structured Worker outcome required by the schema.`;
}

export function recoverFastWorkerPrompt(options: RecoveryPromptOptions): string {
  return `The Workflow Controller process was interrupted while this bounded single-Worker turn was active.

Reload the complete durable task and journal:
${options.journal.task}
${options.journal.journal}

Reinspect the current Workspace before continuing because partial side effects may already exist:
${options.workspace}

Continue from current state without blindly repeating actions. Return a self-contained structured outcome. Return "escalate" if safe continuation now requires decomposition, coordination, broader scope, or architectural judgment.`;
}

export function recoverVerifierPrompt(options: RecoveryPromptOptions): string {
  return `The Workflow Controller process was interrupted while your independent Verification turn was active.

Reload your complete durable task and journal:
${options.journal.task}
${options.journal.journal}

Reinspect the current Workspace and rerun only the targeted checks still needed:
${options.workspace}

Remain independent: do not implement fixes and do not treat the executor's completion claim as proof. Preserve valid evidence, correct stale claims, write the final verification result to ${options.journal.result}, and return only the structured Verification outcome required by the schema.`;
}

export function recoverFinalOrchestratorPrompt(
  options: RecoveryPromptOptions,
): string {
  return `The Workflow Controller process was interrupted while your final judgment turn was active.

Reload the complete durable task and journal:
${options.journal.task}
${options.journal.journal}

Reinspect the current Workspace and the Worker and Verifier artifacts already referenced by the journal before continuing:
${options.workspace}

Continue the same final judgment. Do not implement new changes. Write the final self-contained workflow result to ${options.journal.result} and return only the structured terminal outcome required by the schema.`;
}
