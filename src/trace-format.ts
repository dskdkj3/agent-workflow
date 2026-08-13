import type { AgentUsage } from "./contracts.js";
import type {
  TraceAgent,
  TraceArtifact,
  TraceFastState,
  TraceMeasurement,
  WorkflowTrace,
} from "./trace.js";

function duration(value: number | null): string {
  if (value === null) {
    return "unknown";
  }
  const seconds = Math.floor(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    `${remaining}s`,
  ].filter((part) => part !== "").join(" ");
}

function usage(measurement: TraceMeasurement<AgentUsage>): string {
  const value = measurement.value;
  return (
    `${measurement.status}; input=${value.input_tokens}; ` +
    `cached=${value.cached_input_tokens}; cache_write=` +
    `${value.cache_write_input_tokens}; output=${value.output_tokens}; ` +
    `reasoning=${value.reasoning_output_tokens}`
  );
}

function fast(state: TraceFastState): string {
  const flag = (value: boolean | null): string =>
    value === null ? "unknown" : value ? "yes" : "no";
  return (
    `requested=${state.requested_service_tier} (${flag(state.requested_fast)}); ` +
    `effective=${state.effective_service_tier ?? "unknown"} ` +
    `(${flag(state.effective_fast)})`
  );
}

function formatAgent(agent: TraceAgent, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  const lines = [
    `${indent}- ${agent.role} ${agent.id} [${agent.status}]`,
    `${childIndent}model: ${agent.model}; effort: ${agent.reasoning_effort}; profile: ${agent.profile}`,
    `${childIndent}duration: ${duration(agent.duration_ms)}; thread: ${agent.thread_id ?? "unknown"}`,
    `${childIndent}fast: ${fast(agent.fast)}`,
    `${childIndent}usage: ${usage(agent.usage)}`,
    `${childIndent}quota equivalent: unknown`,
  ];
  if (agent.error !== null) {
    lines.push(
      `${childIndent}error: ${agent.error_kind ?? "unknown"}: ${agent.error}`,
    );
  }
  for (const child of agent.children) {
    lines.push(...formatAgent(child, depth + 1));
  }
  return lines;
}

function artifactLine(item: TraceArtifact): string {
  const state = !item.exists
    ? "missing"
    : item.regular_file
      ? `${item.size_bytes ?? 0} bytes`
      : "not a regular file";
  return `- ${item.kind}: ${item.path} [${state}]`;
}

export function formatWorkflowTrace(trace: WorkflowTrace): string {
  const workflow = trace.workflow;
  const lines = [
    `Workflow ${workflow.id}`,
    `Status: ${workflow.status}`,
    `Route: ${workflow.execution_route}${workflow.retry_route === null ? "" : ` -> ${workflow.retry_route}`}`,
    `Duration: ${duration(workflow.duration_ms)}`,
    `Started: ${workflow.started_at}`,
    `Completed: ${workflow.completed_at ?? "running"}`,
    `Usage: ${usage(workflow.usage)}`,
    `Fast: requested=${workflow.fast.requested ?? "unknown"}; effective=${workflow.fast.effective ?? "unknown"}`,
    `Quota equivalent: unknown`,
    `Summary: ${workflow.summary ?? "not available"}`,
    `Result: ${workflow.result_path ?? "not available"}`,
  ];
  if (workflow.failure_kind !== null) {
    lines.push(`Failure: ${workflow.failure_kind}`);
  }
  if (workflow.recovery_requires_user_approval) {
    lines.push("Recovery: explicit user approval required");
  }
  if (workflow.questions.length > 0) {
    lines.push("Questions:", ...workflow.questions.map((item) => `- ${item}`));
  }
  if (workflow.blocker !== null) {
    lines.push(`Blocker: ${workflow.blocker}`);
  }

  lines.push("", "Agents:");
  if (trace.agents.length === 0) {
    lines.push("- none");
  } else {
    for (const agent of trace.agents) {
      lines.push(...formatAgent(agent, 0));
    }
  }

  lines.push("", "Timeline:");
  for (const event of trace.timeline) {
    lines.push(
      `- #${event.sequence} ${event.created_at} ${event.type}` +
        `${event.run_id === null ? "" : ` (${event.run_id})`}`,
    );
  }
  if (trace.timeline.length === 0) {
    lines.push("- none");
  }

  lines.push("", "Checkpoints:");
  for (const checkpoint of trace.checkpoints) {
    lines.push(
      `- #${checkpoint.sequence} ${checkpoint.kind}: ${checkpoint.commit_id}`,
    );
  }
  if (trace.checkpoints.length === 0) {
    lines.push("- none");
  }

  lines.push("", "Recovery decisions:");
  for (const decision of trace.recovery_decisions) {
    lines.push(
      `- ${decision.decision} (${decision.decision_id}) at ${decision.created_at}` +
        `${decision.note === null ? "" : `: ${decision.note}`}`,
    );
  }
  if (trace.recovery_decisions.length === 0) {
    lines.push("- none");
  }

  lines.push("", "Artifacts:");
  const uniqueArtifacts = new Map(
    trace.artifacts.map((item) => [`${item.kind}\0${item.path}`, item]),
  );
  lines.push(...[...uniqueArtifacts.values()].map(artifactLine));
  if (uniqueArtifacts.size === 0) {
    lines.push("- none");
  }

  lines.push("", "Evidence:");
  for (const reference of trace.evidence) {
    lines.push(
      `- ${reference.issue}: ${reference.evidence}` +
        `${reference.artifact_path === null ? "" : ` (${reference.artifact_path})`}`,
    );
  }
  if (trace.evidence.length === 0) {
    lines.push("- none");
  }

  return `${lines.join("\n")}\n`;
}
