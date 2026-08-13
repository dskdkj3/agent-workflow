import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  addUsage,
  emptyUsage,
  type AgentRole,
  type AgentUsage,
  type ExecutionRoute,
  type ModelProfile,
  type UsageStatus,
} from "./contracts.js";
import {
  StateStore,
  type StoredAgentRun,
  type StoredEvent,
} from "./state.js";

export type WorkflowTraceStatus =
  | "running"
  | "completed"
  | "needs_input"
  | "blocked"
  | "failed"
  | "cancelled";

export interface TraceMeasurement<T> {
  status: UsageStatus;
  value: T;
  source: string | null;
}

export interface TraceUnknownMeasurement {
  status: "unknown";
  value: null;
  unit: "equivalent_credit";
  source: null;
}

export interface TraceFastState {
  requested_service_tier: string;
  requested_fast: boolean | null;
  effective_service_tier: string | null;
  effective_fast: boolean | null;
}

export interface TraceWorkflowFastState {
  requested: boolean | null;
  effective: boolean | null;
  requested_service_tiers: string[];
  effective_service_tiers: string[];
}

export interface TraceArtifact {
  kind: "task" | "journal" | "result" | "evidence";
  run_id: string | null;
  path: string;
  exists: boolean;
  regular_file: boolean;
  size_bytes: number | null;
}

export interface TraceEvidenceReference {
  run_id: string | null;
  event_sequence: number;
  issue: string;
  evidence: string;
  artifact_path: string | null;
}

export interface TraceAgent {
  id: string;
  parent_run_id: string | null;
  role: AgentRole;
  profile: ModelProfile;
  model: string;
  reasoning_effort: "high" | "max";
  status: string;
  thread_id: string | null;
  task_dir: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  fast: TraceFastState;
  usage: TraceMeasurement<AgentUsage>;
  quota_equivalent: TraceUnknownMeasurement;
  error: string | null;
  error_kind: string | null;
  artifacts: TraceArtifact[];
  children: TraceAgent[];
}

export interface TraceTimelineEvent {
  sequence: number;
  run_id: string | null;
  type: string;
  created_at: string;
  payload: unknown;
}

export interface TraceCheckpoint {
  sequence: number;
  run_id: string | null;
  kind: string;
  commit_id: string;
  created_at: string;
}

export interface TraceRecoveryDecision {
  sequence: number;
  decision_id: string;
  decision: "approved" | "denied";
  note: string | null;
  created_at: string;
}

export interface WorkflowTrace {
  schema_version: "1";
  generated_at: string;
  revision: string;
  workflow: {
    id: string;
    request: string;
    workspace: string;
    task_dir: string;
    execution_route: ExecutionRoute;
    retry_route: "orchestrated" | null;
    status: WorkflowTraceStatus;
    summary: string | null;
    result_path: string | null;
    questions: string[];
    blocker: string | null;
    failure_kind: string | null;
    recovery_requires_user_approval: boolean;
    started_at: string;
    updated_at: string;
    completed_at: string | null;
    duration_ms: number | null;
    active_lease: {
      owner: string;
      epoch: number;
      claimed_at: string | null;
      expires_at: string | null;
    } | null;
    fast: TraceWorkflowFastState;
    usage: TraceMeasurement<AgentUsage>;
    quota_equivalent: TraceUnknownMeasurement;
  };
  agents: TraceAgent[];
  timeline: TraceTimelineEvent[];
  checkpoints: TraceCheckpoint[];
  recovery_decisions: TraceRecoveryDecision[];
  artifacts: TraceArtifact[];
  evidence: TraceEvidenceReference[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function durationMs(start: string, end: string | null): number | null {
  const startMs = Date.parse(start);
  const endMs = end === null ? NaN : Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  return Math.max(0, endMs - startMs);
}

function fastValue(tier: string | null): boolean | null {
  if (tier === null) {
    return null;
  }
  const normalized = tier.trim().toLowerCase();
  if (normalized === "fast" || normalized === "priority") {
    return true;
  }
  if (normalized === "default" || normalized === "standard") {
    return false;
  }
  return null;
}

function usageMeasurement(
  usage: AgentUsage,
  status: UsageStatus,
): TraceMeasurement<AgentUsage> {
  return {
    status,
    value: usage,
    source:
      status === "unknown"
        ? null
        : status === "estimated"
          ? "implementation_estimate"
          : status === "partial"
            ? "codex_sdk_partial_cumulative_thread_usage"
            : "codex_sdk_cumulative_thread_usage",
  };
}

function aggregateRunUsage(
  runs: StoredAgentRun[],
  fallback: TraceMeasurement<AgentUsage>,
): TraceMeasurement<AgentUsage> {
  if (runs.length === 0) {
    return fallback;
  }
  const value = runs.reduce(
    (total, run) => addUsage(total, run.usage),
    emptyUsage(),
  );
  const statuses = runs.map((run) => run.usageStatus);
  const status: UsageStatus = statuses.every((item) => item === "unknown")
    ? "unknown"
    : statuses.every((item) => item === "measured")
      ? "measured"
      : statuses.every((item) => item === "estimated")
        ? "estimated"
        : "partial";
  return usageMeasurement(value, status);
}

function unknownQuota(): TraceUnknownMeasurement {
  return {
    status: "unknown",
    value: null,
    unit: "equivalent_credit",
    source: null,
  };
}

function artifact(
  path: string,
  kind: TraceArtifact["kind"],
  runId: string | null,
): TraceArtifact {
  try {
    const entry = lstatSync(path);
    return {
      kind,
      run_id: runId,
      path,
      exists: true,
      regular_file: entry.isFile(),
      size_bytes: entry.isFile() ? entry.size : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return {
      kind,
      run_id: runId,
      path,
      exists: false,
      regular_file: false,
      size_bytes: null,
    };
  }
}

function runArtifacts(run: StoredAgentRun): TraceArtifact[] {
  return [
    artifact(join(run.taskDir, "task.md"), "task", run.id),
    artifact(join(run.taskDir, "journal.md"), "journal", run.id),
    artifact(join(run.taskDir, "result.md"), "result", run.id),
  ];
}

function terminalPayload(
  events: StoredEvent[],
): Record<string, unknown> | null {
  const terminal = events.findLast((event) => event.type === "workflow.terminal");
  return terminal !== undefined && isRecord(terminal.payload)
    ? terminal.payload
    : null;
}

function recoveryDecisions(events: StoredEvent[]): TraceRecoveryDecision[] {
  return events.flatMap((event) => {
    if (
      event.type !== "workflow.recovery_approved" &&
      event.type !== "workflow.recovery_denied"
    ) {
      return [];
    }
    const payload = isRecord(event.payload) ? event.payload : {};
    return [
      {
        sequence: event.sequence,
        decision_id: String(payload.decision_id ?? "unknown"),
        decision:
          event.type === "workflow.recovery_approved"
            ? "approved"
            : "denied",
        note: typeof payload.note === "string" ? payload.note : null,
        created_at: event.createdAt,
      },
    ];
  });
}

function evidenceReferences(
  events: StoredEvent[],
  workspace: string,
  taskDir: string,
): TraceEvidenceReference[] {
  const references: TraceEvidenceReference[] = [];
  for (const event of events) {
    if (event.type !== "verifier.completed" || !isRecord(event.payload)) {
      continue;
    }
    const outcome = event.payload.outcome;
    if (!isRecord(outcome) || !Array.isArray(outcome.findings)) {
      continue;
    }
    for (const finding of outcome.findings) {
      if (!isRecord(finding)) {
        continue;
      }
      const issue = String(finding.issue ?? "Unspecified verification finding");
      const evidence = String(finding.evidence ?? "Unspecified evidence");
      let evidencePath: string | null = null;
      if (isAbsolute(evidence)) {
        const resolved = resolve(evidence);
        if (
          resolved === resolve(workspace) ||
          resolved.startsWith(`${resolve(workspace)}/`) ||
          resolved === resolve(taskDir) ||
          resolved.startsWith(`${resolve(taskDir)}/`)
        ) {
          evidencePath = resolved;
        }
      }
      references.push({
        run_id: event.runId,
        event_sequence: event.sequence,
        issue,
        evidence,
        artifact_path: evidencePath,
      });
    }
  }
  return references;
}

function buildAgentTree(
  runs: StoredAgentRun[],
  generatedAt: string,
): TraceAgent[] {
  const childrenByParent = new Map<string | null, StoredAgentRun[]>();
  for (const run of runs) {
    const siblings = childrenByParent.get(run.parentRunId) ?? [];
    siblings.push(run);
    childrenByParent.set(run.parentRunId, siblings);
  }

  const build = (run: StoredAgentRun): TraceAgent => ({
    id: run.id,
    parent_run_id: run.parentRunId,
    role: run.role,
    profile: run.profile,
    model: run.model,
    reasoning_effort: run.reasoningEffort,
    status: run.status,
    thread_id: run.threadId,
    task_dir: run.taskDir,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    duration_ms: durationMs(run.startedAt, run.completedAt ?? generatedAt),
    fast: {
      requested_service_tier: run.requestedServiceTier,
      requested_fast: fastValue(run.requestedServiceTier),
      effective_service_tier: run.effectiveServiceTier,
      effective_fast: fastValue(run.effectiveServiceTier),
    },
    usage: usageMeasurement(run.usage, run.usageStatus),
    quota_equivalent: unknownQuota(),
    error: run.error,
    error_kind: run.errorKind,
    artifacts: runArtifacts(run),
    children: (childrenByParent.get(run.id) ?? []).map(build),
  });

  return (childrenByParent.get(null) ?? []).map(build);
}

function aggregateFast(runs: StoredAgentRun[]): TraceWorkflowFastState {
  const requestedServiceTiers = [
    ...new Set(runs.map((run) => run.requestedServiceTier)),
  ];
  const effectiveServiceTiers = [
    ...new Set(
      runs.flatMap((run) =>
        run.effectiveServiceTier === null ? [] : [run.effectiveServiceTier],
      ),
    ),
  ];
  const aggregate = (values: (boolean | null)[]): boolean | null => {
    if (values.length === 0 || values.some((value) => value === null)) {
      return null;
    }
    return values.every((value) => value === true)
      ? true
      : values.every((value) => value === false)
        ? false
        : null;
  };
  return {
    requested: aggregate(
      runs.map((run) => fastValue(run.requestedServiceTier)),
    ),
    effective: aggregate(
      runs.map((run) => fastValue(run.effectiveServiceTier)),
    ),
    requested_service_tiers: requestedServiceTiers,
    effective_service_tiers: effectiveServiceTiers,
  };
}

export function buildWorkflowTrace(
  store: StateStore,
  workflowId: string,
  generatedAt = new Date().toISOString(),
): WorkflowTrace {
  const workflow = store.getStoredWorkflow(workflowId);
  if (workflow === undefined) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }
  const runs = store.listStoredAgentRuns(workflowId);
  const events = store.listStoredEvents(workflowId);
  const checkpoints = store.listStoredCheckpoints(workflowId);
  const terminal = terminalPayload(events);
  const terminalEvent = events.findLast(
    (event) => event.type === "workflow.terminal",
  );
  const completedAt =
    workflow.status === "running"
      ? null
      : terminalEvent?.createdAt ?? workflow.updatedAt;
  const retryRoute =
    terminal?.retry_route === "orchestrated" ? "orchestrated" : null;
  const runArtifactList = runs.flatMap(runArtifacts);
  const evidence = evidenceReferences(
    events,
    workflow.workspace,
    workflow.taskDir,
  );
  const evidenceArtifacts = evidence.flatMap((reference) =>
    reference.artifact_path === null
      ? []
      : [artifact(reference.artifact_path, "evidence", reference.run_id)],
  );
  const resultArtifact =
    workflow.resultPath === null
      ? []
      : [artifact(workflow.resultPath, "result", null)];
  const artifacts = [
    ...new Map(
      [...runArtifactList, ...resultArtifact, ...evidenceArtifacts].map(
        (item) => [`${item.kind}\0${item.path}`, item],
      ),
    ).values(),
  ];
  const lastEventSequence = events.at(-1)?.sequence ?? 0;
  const lastCheckpointSequence = checkpoints.at(-1)?.sequence ?? 0;

  return {
    schema_version: "1",
    generated_at: generatedAt,
    revision:
      `${workflow.updatedAt}:${lastEventSequence}:` +
      `${lastCheckpointSequence}:${workflow.leaseEpoch}`,
    workflow: {
      id: workflow.id,
      request: workflow.request,
      workspace: workflow.workspace,
      task_dir: workflow.taskDir,
      execution_route: workflow.executionRoute,
      retry_route: retryRoute,
      status: workflow.status as WorkflowTraceStatus,
      summary: workflow.summary,
      result_path: workflow.resultPath,
      questions: workflow.questions,
      blocker: workflow.blocker,
      failure_kind: workflow.failureKind,
      recovery_requires_user_approval:
        workflow.recoveryRequiresUserApproval,
      started_at: workflow.createdAt,
      updated_at: workflow.updatedAt,
      completed_at: completedAt,
      duration_ms: durationMs(
        workflow.createdAt,
        completedAt ?? generatedAt,
      ),
      active_lease:
        workflow.leaseOwner === null
          ? null
          : {
              owner: workflow.leaseOwner,
              epoch: workflow.leaseEpoch,
              claimed_at: workflow.leaseClaimedAt,
              expires_at: workflow.leaseExpiresAt,
            },
      fast: aggregateFast(runs),
      usage: aggregateRunUsage(
        runs,
        usageMeasurement(workflow.usage, workflow.usageStatus),
      ),
      quota_equivalent: unknownQuota(),
    },
    agents: buildAgentTree(runs, generatedAt),
    timeline: events.map((event) => ({
      sequence: event.sequence,
      run_id: event.runId,
      type: event.type,
      created_at: event.createdAt,
      payload: event.payload,
    })),
    checkpoints: checkpoints.map((checkpoint) => ({
      sequence: checkpoint.sequence,
      run_id: checkpoint.runId,
      kind: checkpoint.kind,
      commit_id: checkpoint.commitId,
      created_at: checkpoint.createdAt,
    })),
    recovery_decisions: recoveryDecisions(events),
    artifacts,
    evidence,
  };
}

export function loadWorkflowTrace(
  stateDir: string,
  workflowId: string | "latest",
): WorkflowTrace {
  const databasePath = join(resolve(stateDir), "controller.sqlite3");
  if (!existsSync(databasePath)) {
    throw new Error("No workflows are stored");
  }
  const store = new StateStore(databasePath, {
    readOnly: true,
  });
  try {
    const resolvedId =
      workflowId === "latest" ? store.latestWorkflowId() : workflowId;
    if (resolvedId === null) {
      throw new Error("No workflows are stored");
    }
    return buildWorkflowTrace(store, resolvedId);
  } finally {
    store.close();
  }
}

export function emptyWorkflowUsage(): AgentUsage {
  return emptyUsage();
}
