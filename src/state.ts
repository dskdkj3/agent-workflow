import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  emptyUsage,
  executionRouteSchema,
  modelProfileSchema,
  modelProfiles,
  roleSchema,
  usageSchema,
  usageStatusSchema,
  workflowRunOutputSchema,
  type AgentRole,
  type AgentUsage,
  type ExecutionRoute,
  type ModelProfile,
  type RecoveryDecisionInput,
  type RecoveryDecisionOutput,
  type UsageStatus,
  type WorkflowRunOutput,
} from "./contracts.js";

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface CreateAgentRun {
  id: string;
  workflowId: string;
  parentRunId: string | null;
  role: AgentRole;
  profile: ModelProfile;
  taskDir: string;
  model: string;
  reasoningEffort: "high" | "max";
  requestedServiceTier: string;
}

export interface WorkflowLease {
  workflowId: string;
  owner: string;
  epoch: number;
  claimedAt: string;
}

export class WorkflowLeaseLostError extends Error {
  constructor(workflowId: string) {
    super(`Controller lease was lost for workflow ${workflowId}`);
    this.name = "WorkflowLeaseLostError";
  }
}

export interface StoredWorkflow {
  id: string;
  request: string;
  workspace: string;
  taskDir: string;
  executionRoute: ExecutionRoute;
  completionCriteria: string[];
  status: string;
  summary: string | null;
  resultPath: string | null;
  questions: string[];
  blocker: string | null;
  usage: AgentUsage;
  usageStatus: UsageStatus;
  failureKind: string | null;
  recoveryRequiresUserApproval: boolean;
  leaseOwner: string | null;
  leaseEpoch: number;
  leaseClaimedAt: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAgentRun {
  id: string;
  workflowId: string;
  parentRunId: string | null;
  role: AgentRole;
  profile: ModelProfile;
  model: string;
  reasoningEffort: "high" | "max";
  requestedServiceTier: string;
  effectiveServiceTier: string | null;
  taskDir: string;
  threadId: string | null;
  status: AgentRunStatus;
  usage: AgentUsage;
  usageStatus: UsageStatus;
  error: string | null;
  errorKind: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface StoredEvent<T = unknown> {
  sequence: number;
  workflowId: string;
  runId: string | null;
  type: string;
  payload: T;
  createdAt: string;
}

export interface StoredCheckpoint {
  sequence: number;
  workflowId: string;
  runId: string | null;
  kind: string;
  commitId: string;
  createdAt: string;
}

export interface StateStoreOptions {
  readOnly?: boolean;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.trim() === "") {
    return fallback;
  }
  return JSON.parse(raw) as T;
}

function parseUsage(raw: unknown): AgentUsage {
  return usageSchema.parse(parseJson(raw, emptyUsage()));
}

function nullableString(raw: unknown): string | null {
  return raw === null || raw === undefined ? null : String(raw);
}

function parseUsageStatus(raw: unknown): UsageStatus {
  return raw === null || raw === undefined
    ? "unknown"
    : usageStatusSchema.parse(raw);
}

function rowToWorkflow(row: Record<string, unknown>): StoredWorkflow {
  return {
    id: String(row.id),
    request: String(row.request),
    workspace: String(row.workspace),
    taskDir: String(row.task_dir),
    executionRoute: executionRouteSchema.parse(
      row.execution_route ?? "orchestrated",
    ),
    completionCriteria: parseJson(row.completion_criteria_json, []),
    status: String(row.status),
    summary: nullableString(row.summary),
    resultPath: nullableString(row.result_path),
    questions: parseJson(row.questions_json, []),
    blocker: nullableString(row.blocker),
    usage: parseUsage(row.usage_json),
    usageStatus: parseUsageStatus(row.usage_status),
    failureKind: nullableString(row.failure_kind),
    recoveryRequiresUserApproval:
      Number(row.recovery_requires_user_approval) === 1,
    leaseOwner: nullableString(row.lease_owner),
    leaseEpoch:
      row.lease_epoch === null || row.lease_epoch === undefined
        ? 0
        : Number(row.lease_epoch),
    leaseClaimedAt: nullableString(row.lease_claimed_at),
    leaseExpiresAt: nullableString(row.lease_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToAgentRun(row: Record<string, unknown>): StoredAgentRun {
  const profile = modelProfileSchema.parse(row.profile ?? "sol_high");
  const profileDefinition = modelProfiles[profile];
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    parentRunId: nullableString(row.parent_run_id),
    role: roleSchema.parse(row.role),
    profile,
    model:
      row.model === null || row.model === undefined
        ? profileDefinition.model
        : String(row.model),
    reasoningEffort:
      row.reasoning_effort === null || row.reasoning_effort === undefined
        ? profileDefinition.reasoningEffort
        : row.reasoning_effort === "max"
          ? "max"
          : "high",
    requestedServiceTier:
      row.requested_service_tier === null ||
      row.requested_service_tier === undefined
        ? "default"
        : String(row.requested_service_tier),
    effectiveServiceTier: nullableString(row.effective_service_tier),
    taskDir: String(row.task_dir),
    threadId: nullableString(row.thread_id),
    status: String(row.status) as AgentRunStatus,
    usage: parseUsage(row.usage_json),
    usageStatus: parseUsageStatus(row.usage_status),
    error: nullableString(row.error),
    errorKind: nullableString(row.error_kind),
    startedAt: String(row.started_at),
    completedAt: nullableString(row.completed_at),
  };
}

export class StateStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string, options: StateStoreOptions = {}) {
    if (!options.readOnly) {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath, {
      readOnly: options.readOnly ?? false,
      timeout: 5000,
    });
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA foreign_keys = ON");
    if (options.readOnly) {
      return;
    }
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        request TEXT NOT NULL,
        workspace TEXT NOT NULL,
        task_dir TEXT NOT NULL,
        execution_route TEXT NOT NULL DEFAULT 'orchestrated',
        completion_criteria_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        summary TEXT,
        result_path TEXT,
        questions_json TEXT NOT NULL DEFAULT '[]',
        blocker TEXT,
        usage_json TEXT NOT NULL,
        usage_status TEXT NOT NULL DEFAULT 'unknown',
        failure_kind TEXT,
        recovery_requires_user_approval INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        lease_claimed_at TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id),
        parent_run_id TEXT REFERENCES agent_runs(id),
        role TEXT NOT NULL,
        profile TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        requested_service_tier TEXT NOT NULL DEFAULT 'default',
        effective_service_tier TEXT,
        task_dir TEXT NOT NULL,
        thread_id TEXT,
        status TEXT NOT NULL,
        usage_json TEXT,
        usage_status TEXT NOT NULL DEFAULT 'unknown',
        error TEXT,
        error_kind TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id),
        run_id TEXT REFERENCES agent_runs(id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id),
        run_id TEXT REFERENCES agent_runs(id),
        kind TEXT NOT NULL,
        commit_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.ensureAgentRunProfileColumn();
    this.ensureWorkflowExecutionRouteColumn();
    this.ensureWorkflowRecoveryColumns();
    this.ensureAgentRunTraceColumns();
    this.ensureWorkflowTraceColumns();
  }

  close(): void {
    this.database.close();
  }

  assertWorkflowLease(lease: WorkflowLease): void {
    const row = this.database
      .prepare(`
        SELECT 1
        FROM workflows
        WHERE id = ? AND status = 'running'
          AND lease_owner = ? AND lease_epoch = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
      `)
      .get(
        lease.workflowId,
        lease.owner,
        lease.epoch,
        new Date().toISOString(),
      );
    if (row === undefined) {
      throw new WorkflowLeaseLostError(lease.workflowId);
    }
  }

  private withWorkflowLease<T>(
    lease: WorkflowLease,
    operation: () => T,
  ): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertWorkflowLease(lease);
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original state mutation failure.
      }
      throw error;
    }
  }

  private insertEvent(
    workflowId: string,
    runId: string | null,
    type: string,
    payload: unknown,
  ): void {
    this.database
      .prepare(`
        INSERT INTO events (workflow_id, run_id, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        workflowId,
        runId,
        type,
        JSON.stringify(payload),
        new Date().toISOString(),
      );
  }

  private insertCheckpoint(
    workflowId: string,
    runId: string | null,
    kind: string,
    commitId: string,
  ): void {
    this.database
      .prepare(`
        INSERT INTO checkpoints (
          workflow_id, run_id, kind, commit_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(workflowId, runId, kind, commitId, new Date().toISOString());
  }

  createWorkflow(
    id: string,
    request: string,
    workspace: string,
    taskDir: string,
    executionRoute: ExecutionRoute,
    completionCriteria: string[],
    usage: AgentUsage,
  ): void {
    if (
      !this.createWorkflowIfAbsent(
        id,
        request,
        workspace,
        taskDir,
        executionRoute,
        completionCriteria,
        usage,
      )
    ) {
      throw new Error(`Workflow already exists: ${id}`);
    }
  }

  createWorkflowIfAbsent(
    id: string,
    request: string,
    workspace: string,
    taskDir: string,
    executionRoute: ExecutionRoute,
    completionCriteria: string[],
    usage: AgentUsage,
  ): boolean {
    const now = new Date().toISOString();
    const inserted = this.database
      .prepare(`
        INSERT OR IGNORE INTO workflows (
          id, request, workspace, task_dir, execution_route,
          completion_criteria_json, status, usage_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
      `)
      .run(
        id,
        request,
        workspace,
        taskDir,
        executionRoute,
        JSON.stringify(completionCriteria),
        JSON.stringify(usage),
        now,
        now,
      );
    return Number(inserted.changes) === 1;
  }

  finishWorkflow(lease: WorkflowLease, output: WorkflowRunOutput): void {
    this.withWorkflowLease(lease, () => {
      const updated = this.database
        .prepare(`
          UPDATE workflows
          SET status = ?, summary = ?, result_path = ?, questions_json = ?, blocker = ?,
              usage_json = ?, usage_status = ?, failure_kind = ?,
              recovery_requires_user_approval = ?,
              lease_owner = NULL, lease_claimed_at = NULL, lease_expires_at = NULL,
              updated_at = ?
          WHERE id = ? AND status = 'running'
            AND lease_owner = ? AND lease_epoch = ?
        `)
        .run(
          output.status,
          output.summary,
          output.result_path,
          JSON.stringify(output.questions),
          output.blocker,
          JSON.stringify(output.usage),
          output.usage_status,
          output.failure_kind,
          output.recovery_requires_user_approval ? 1 : 0,
          new Date().toISOString(),
          output.workflow_id,
          lease.owner,
          lease.epoch,
        );
      if (Number(updated.changes) !== 1) {
        throw new WorkflowLeaseLostError(output.workflow_id);
      }

      this.insertEvent(output.workflow_id, null, "workflow.terminal", output);
    });
  }

  terminalOutput(id: string): WorkflowRunOutput | null {
    const workflow = this.getStoredWorkflow(id);
    if (workflow === undefined || workflow.status === "running") {
      return null;
    }
    return workflowRunOutputSchema.parse({
      workflow_id: workflow.id,
      status: workflow.status,
      summary: workflow.summary,
      task_dir: workflow.taskDir,
      result_path: workflow.resultPath,
      questions: workflow.questions,
      blocker: workflow.blocker,
      usage: workflow.usage,
      usage_status: workflow.usageStatus,
      execution_route: workflow.executionRoute,
      retry_route: this.terminalRetryRoute(id),
      failure_kind: workflow.failureKind,
      recovery_requires_user_approval:
        workflow.recoveryRequiresUserApproval,
    });
  }

  private terminalRetryRoute(id: string): "orchestrated" | null {
    const terminal = this.latestEvent<Record<string, unknown>>(
      id,
      "workflow.terminal",
    );
    return terminal?.payload.retry_route === "orchestrated"
      ? "orchestrated"
      : null;
  }

  claimWorkflow(
    id: string,
    owner: string,
    leaseMs: number,
  ): WorkflowLease | null {
    const now = new Date();
    const claimedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const claimed = this.database
      .prepare(`
        UPDATE workflows
        SET lease_owner = ?, lease_epoch = lease_epoch + 1,
            lease_claimed_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
          AND (
            lease_owner IS NULL OR lease_expires_at IS NULL OR
            lease_expires_at <= ?
          )
        RETURNING lease_epoch
      `)
      .get(owner, claimedAt, expiresAt, claimedAt, id, claimedAt) as
      | { lease_epoch: number }
      | undefined;
    return claimed === undefined
      ? null
      : {
          workflowId: id,
          owner,
          epoch: Number(claimed.lease_epoch),
          claimedAt,
        };
  }

  heartbeatWorkflow(lease: WorkflowLease, leaseMs: number): boolean {
    const now = new Date();
    const updated = this.database
      .prepare(`
        UPDATE workflows
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
          AND lease_owner = ? AND lease_epoch = ?
      `)
      .run(
        new Date(now.getTime() + leaseMs).toISOString(),
        now.toISOString(),
        lease.workflowId,
        lease.owner,
        lease.epoch,
      );
    return Number(updated.changes) === 1;
  }

  releaseWorkflow(lease: WorkflowLease): void {
    this.database
      .prepare(`
        UPDATE workflows
        SET lease_owner = NULL, lease_claimed_at = NULL,
            lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND lease_epoch = ?
      `)
      .run(
        new Date().toISOString(),
        lease.workflowId,
        lease.owner,
        lease.epoch,
      );
  }

  recordRecoveryDecision(
    input: RecoveryDecisionInput,
  ): RecoveryDecisionOutput {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const workflow = this.getStoredWorkflow(input.workflow_id);
      if (
        workflow === undefined ||
        workflow.status !== "failed" ||
        workflow.failureKind !== "cyber_policy" ||
        !workflow.recoveryRequiresUserApproval
      ) {
        throw new Error(
          `Workflow ${input.workflow_id} is not awaiting a cyber_policy recovery decision`,
        );
      }
      const existing = this.database
        .prepare(`
          SELECT type, payload_json, created_at
          FROM events
          WHERE workflow_id = ?
            AND type IN ('workflow.recovery_approved', 'workflow.recovery_denied')
            AND json_extract(payload_json, '$.decision_id') = ?
          ORDER BY sequence DESC LIMIT 1
        `)
        .get(input.workflow_id, input.decision_id) as
        | { type: string; payload_json: string; created_at: string }
        | undefined;
      if (existing !== undefined) {
        const payload = parseJson<Record<string, unknown>>(
          existing.payload_json,
          {},
        );
        const existingDecision =
          existing.type === "workflow.recovery_approved"
            ? "approved"
            : "denied";
        if (
          existingDecision !== input.decision ||
          (payload.note ?? undefined) !== input.note
        ) {
          throw new Error(
            `Recovery decision ${input.decision_id} was already recorded with different content`,
          );
        }
        this.database.exec("COMMIT");
        return {
          workflow_id: input.workflow_id,
          decision_id: input.decision_id,
          decision: existingDecision,
          recorded_at: existing.created_at,
        };
      }

      const recordedAt = new Date().toISOString();
      this.database
        .prepare(`
          INSERT INTO events (workflow_id, run_id, type, payload_json, created_at)
          VALUES (?, NULL, ?, ?, ?)
        `)
        .run(
          input.workflow_id,
          input.decision === "approved"
            ? "workflow.recovery_approved"
            : "workflow.recovery_denied",
          JSON.stringify({
            decision_id: input.decision_id,
            decision: input.decision,
            ...(input.note === undefined ? {} : { note: input.note }),
          }),
          recordedAt,
        );
      this.database.exec("COMMIT");
      return {
        workflow_id: input.workflow_id,
        decision_id: input.decision_id,
        decision: input.decision,
        recorded_at: recordedAt,
      };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original validation or persistence failure.
      }
      throw error;
    }
  }

  recordAgentProgress(
    lease: WorkflowLease,
    runId: string,
    usage: AgentUsage,
    usageStatus: UsageStatus,
    eventType: string,
    payload: unknown,
    effectiveServiceTier?: string | null,
  ): void {
    this.withWorkflowLease(lease, () => {
      const row = this.database
        .prepare("SELECT workflow_id FROM agent_runs WHERE id = ?")
        .get(runId) as { workflow_id: string } | undefined;
      if (row === undefined) {
        throw new Error(`Unknown agent run: ${runId}`);
      }
      if (row.workflow_id !== lease.workflowId) {
        throw new Error(`Agent run ${runId} belongs to another workflow`);
      }
      const updated = this.database
        .prepare(`
          UPDATE agent_runs
          SET usage_json = ?, usage_status = ?,
              effective_service_tier = COALESCE(?, effective_service_tier)
          WHERE id = ? AND status = 'running'
        `)
        .run(
          JSON.stringify(usage),
          usageStatus,
          effectiveServiceTier ?? null,
          runId,
        );
      if (Number(updated.changes) !== 1) {
        throw new Error(`Agent run is not running: ${runId}`);
      }
      this.insertEvent(row.workflow_id, runId, eventType, payload);
    });
  }

  createAgentRun(lease: WorkflowLease, input: CreateAgentRun): void {
    if (input.workflowId !== lease.workflowId) {
      throw new Error("Cannot create an Agent run under another Workflow lease");
    }
    this.withWorkflowLease(lease, () => {
      const startedAt = new Date().toISOString();
      this.database
        .prepare(`
          INSERT INTO agent_runs (
            id, workflow_id, parent_run_id, role, profile, model,
            reasoning_effort, requested_service_tier, task_dir, status,
            usage_json, usage_status, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 'unknown', ?)
        `)
        .run(
          input.id,
          input.workflowId,
          input.parentRunId,
          input.role,
          input.profile,
          input.model,
          input.reasoningEffort,
          input.requestedServiceTier,
          input.taskDir,
          JSON.stringify(emptyUsage()),
          startedAt,
        );
      this.insertEvent(input.workflowId, input.id, "agent.dispatched", {
        parent_run_id: input.parentRunId,
        role: input.role,
        profile: input.profile,
        model: input.model,
        reasoning_effort: input.reasoningEffort,
        requested_service_tier: input.requestedServiceTier,
        task_dir: input.taskDir,
      });
    });
  }

  setAgentThread(
    lease: WorkflowLease,
    runId: string,
    threadId: string,
    recoveredFromCompletedTurn = false,
  ): void {
    this.withWorkflowLease(lease, () => {
      const updated = this.database
        .prepare(`
          UPDATE agent_runs
          SET thread_id = ?
          WHERE id = ? AND workflow_id = ? AND status = 'running'
        `)
        .run(threadId, runId, lease.workflowId);
      if (Number(updated.changes) !== 1) {
        throw new Error(`Agent run is not running: ${runId}`);
      }
      this.insertEvent(lease.workflowId, runId, "agent.thread_started", {
        thread_id: threadId,
        ...(recoveredFromCompletedTurn
          ? { recovered_from_completed_turn: true }
          : {}),
      });
    });
  }

  finishAgentRun(
    lease: WorkflowLease,
    runId: string,
    status: AgentRunStatus,
    usage: AgentUsage,
    usageStatus: UsageStatus,
    error: string | null = null,
    errorKind: string | null = null,
  ): void {
    this.withWorkflowLease(lease, () => {
      const updated = this.database
        .prepare(`
          UPDATE agent_runs
          SET status = ?, usage_json = ?, usage_status = ?, error = ?,
              error_kind = ?, completed_at = ?
          WHERE id = ? AND workflow_id = ? AND status = 'running'
        `)
        .run(
          status,
          JSON.stringify(usage),
          usageStatus,
          error,
          errorKind,
          new Date().toISOString(),
          runId,
          lease.workflowId,
        );
      if (Number(updated.changes) !== 1) {
        throw new Error(`Agent run is not running: ${runId}`);
      }
      this.insertEvent(lease.workflowId, runId, `agent.${status}`, {
        usage,
        usage_status: usageStatus,
        error,
        error_kind: errorKind,
      });
    });
  }

  completeAgentRun(
    lease: WorkflowLease,
    runId: string,
    usage: AgentUsage,
    usageStatus: UsageStatus,
    eventType: string,
    payload: unknown,
    effectiveServiceTier?: string | null,
  ): void {
    this.withWorkflowLease(lease, () => {
      const row = this.database
        .prepare("SELECT workflow_id FROM agent_runs WHERE id = ?")
        .get(runId) as { workflow_id: string } | undefined;
      if (row === undefined) {
        throw new Error(`Unknown agent run: ${runId}`);
      }
      if (row.workflow_id !== lease.workflowId) {
        throw new Error(`Agent run ${runId} belongs to another workflow`);
      }
      const updated = this.database
        .prepare(`
          UPDATE agent_runs
          SET status = 'completed', usage_json = ?, usage_status = ?,
              effective_service_tier = COALESCE(?, effective_service_tier),
              error = NULL, error_kind = NULL, completed_at = ?
          WHERE id = ? AND status = 'running'
        `)
        .run(
          JSON.stringify(usage),
          usageStatus,
          effectiveServiceTier ?? null,
          new Date().toISOString(),
          runId,
        );
      if (Number(updated.changes) !== 1) {
        throw new Error(`Agent run is not running: ${runId}`);
      }
      this.insertEvent(row.workflow_id, runId, eventType, payload);
      this.insertEvent(row.workflow_id, runId, "agent.completed", {
        usage,
        usage_status: usageStatus,
      });
    });
  }

  appendEvent(
    lease: WorkflowLease,
    runId: string | null,
    type: string,
    payload: unknown,
  ): void {
    this.withWorkflowLease(lease, () => {
      this.insertEvent(lease.workflowId, runId, type, payload);
    });
  }

  recordCheckpoint(
    lease: WorkflowLease,
    runId: string | null,
    kind: string,
    commitId: string,
    eventType = "checkpoint.committed",
  ): void {
    this.withWorkflowLease(lease, () => {
      this.insertCheckpoint(lease.workflowId, runId, kind, commitId);
      this.insertEvent(lease.workflowId, runId, eventType, {
        kind,
        commit_id: commitId,
      });
    });
  }

  getStoredWorkflow(id: string): StoredWorkflow | undefined {
    const row = this.database
      .prepare("SELECT * FROM workflows WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToWorkflow(row);
  }

  getStoredAgentRun(id: string): StoredAgentRun | undefined {
    const row = this.database
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : rowToAgentRun(row);
  }

  listStoredAgentRuns(workflowId: string): StoredAgentRun[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM agent_runs WHERE workflow_id = ? ORDER BY started_at, id",
        )
        .all(workflowId) as Record<string, unknown>[]
    ).map(rowToAgentRun);
  }

  listStoredEvents(workflowId: string): StoredEvent[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM events WHERE workflow_id = ? ORDER BY sequence",
        )
        .all(workflowId) as Record<string, unknown>[]
    ).map((row) => ({
      sequence: Number(row.sequence),
      workflowId: String(row.workflow_id),
      runId: row.run_id === null ? null : String(row.run_id),
      type: String(row.type),
      payload: parseJson(row.payload_json, null),
      createdAt: String(row.created_at),
    }));
  }

  listStoredCheckpoints(workflowId: string): StoredCheckpoint[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM checkpoints WHERE workflow_id = ? ORDER BY sequence",
        )
        .all(workflowId) as Record<string, unknown>[]
    ).map((row) => ({
      sequence: Number(row.sequence),
      workflowId: String(row.workflow_id),
      runId: row.run_id === null ? null : String(row.run_id),
      kind: String(row.kind),
      commitId: String(row.commit_id),
      createdAt: String(row.created_at),
    }));
  }

  latestWorkflowId(): string | null {
    const row = this.database
      .prepare("SELECT id FROM workflows ORDER BY created_at DESC, id DESC LIMIT 1")
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  latestEvent<T = unknown>(
    workflowId: string,
    type: string,
  ): StoredEvent<T> | undefined {
    const row = this.database
      .prepare(`
        SELECT * FROM events
        WHERE workflow_id = ? AND type = ?
        ORDER BY sequence DESC LIMIT 1
      `)
      .get(workflowId, type) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      sequence: Number(row.sequence),
      workflowId: String(row.workflow_id),
      runId: row.run_id === null ? null : String(row.run_id),
      type: String(row.type),
      payload: parseJson(row.payload_json, null) as T,
      createdAt: String(row.created_at),
    };
  }

  getWorkflow(id: string): Record<string, unknown> | undefined {
    return this.database
      .prepare("SELECT * FROM workflows WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
  }

  listAgentRuns(workflowId: string): Record<string, unknown>[] {
    return this.database
      .prepare(
        "SELECT * FROM agent_runs WHERE workflow_id = ? ORDER BY started_at, id",
      )
      .all(workflowId) as Record<string, unknown>[];
  }

  listCheckpoints(workflowId: string): Record<string, unknown>[] {
    return this.database
      .prepare(
        "SELECT * FROM checkpoints WHERE workflow_id = ? ORDER BY sequence",
      )
      .all(workflowId) as Record<string, unknown>[];
  }

  hasCheckpoint(workflowId: string, kind: string): boolean {
    return (
      this.database
        .prepare(
          "SELECT 1 FROM checkpoints WHERE workflow_id = ? AND kind = ? LIMIT 1",
        )
        .get(workflowId, kind) !== undefined
    );
  }

  hasCheckpointCommit(workflowId: string, commitId: string): boolean {
    return (
      this.database
        .prepare(
          "SELECT 1 FROM checkpoints WHERE workflow_id = ? AND commit_id = ? LIMIT 1",
        )
        .get(workflowId, commitId) !== undefined
    );
  }

  private ensureAgentRunProfileColumn(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(agent_runs)")
      .all() as { name: string }[];
    if (!columns.some((column) => column.name === "profile")) {
      this.database.exec(
        "ALTER TABLE agent_runs ADD COLUMN profile TEXT NOT NULL DEFAULT 'sol_high'",
      );
    }
  }

  private ensureWorkflowExecutionRouteColumn(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(workflows)")
      .all() as { name: string }[];
    if (!columns.some((column) => column.name === "execution_route")) {
      this.database.exec(
        "ALTER TABLE workflows ADD COLUMN execution_route TEXT NOT NULL DEFAULT 'orchestrated'",
      );
    }
  }

  private ensureWorkflowRecoveryColumns(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(workflows)")
      .all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("completion_criteria_json")) {
      this.database.exec(
        "ALTER TABLE workflows ADD COLUMN completion_criteria_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    if (!names.has("lease_owner")) {
      this.database.exec("ALTER TABLE workflows ADD COLUMN lease_owner TEXT");
    }
    if (!names.has("lease_expires_at")) {
      this.database.exec(
        "ALTER TABLE workflows ADD COLUMN lease_expires_at TEXT",
      );
    }
  }

  private ensureWorkflowTraceColumns(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(workflows)")
      .all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("usage_status")) {
      this.database.exec(
        "ALTER TABLE workflows ADD COLUMN usage_status TEXT NOT NULL DEFAULT 'unknown'",
      );
    }
    if (!names.has("failure_kind")) {
      this.database.exec("ALTER TABLE workflows ADD COLUMN failure_kind TEXT");
    }
    if (!names.has("recovery_requires_user_approval")) {
      this.database.exec(
        "ALTER TABLE workflows ADD COLUMN recovery_requires_user_approval INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!names.has("lease_epoch")) {
      this.database.exec(
        "ALTER TABLE workflows ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!names.has("lease_claimed_at")) {
      this.database.exec("ALTER TABLE workflows ADD COLUMN lease_claimed_at TEXT");
    }

    this.database.exec(`
      UPDATE workflows
      SET failure_kind = CASE
            WHEN status = 'failed' AND (
              lower(COALESCE(summary, '')) LIKE '%flagged for possible cybersecurity risk%'
              OR lower(COALESCE(blocker, '')) LIKE '%chatgpt.com/cyber%'
              OR lower(COALESCE(summary, '')) LIKE '%cyber_policy%'
            ) THEN 'cyber_policy'
            WHEN status = 'failed' AND failure_kind IS NULL THEN 'execution_error'
            ELSE failure_kind
          END,
          recovery_requires_user_approval = CASE
            WHEN status = 'failed' AND (
              lower(COALESCE(summary, '')) LIKE '%flagged for possible cybersecurity risk%'
              OR lower(COALESCE(blocker, '')) LIKE '%chatgpt.com/cyber%'
              OR lower(COALESCE(summary, '')) LIKE '%cyber_policy%'
            ) THEN 1
            ELSE recovery_requires_user_approval
          END
    `);

    this.database.exec(`
      UPDATE workflows
      SET usage_status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM agent_runs WHERE agent_runs.workflow_id = workflows.id
        ) THEN 'unknown'
        WHEN EXISTS (
          SELECT 1 FROM agent_runs
          WHERE agent_runs.workflow_id = workflows.id
            AND agent_runs.usage_status IN ('unknown', 'partial')
        ) AND EXISTS (
          SELECT 1 FROM agent_runs
          WHERE agent_runs.workflow_id = workflows.id
            AND agent_runs.usage_status IN ('measured', 'partial')
        ) THEN 'partial'
        WHEN EXISTS (
          SELECT 1 FROM agent_runs
          WHERE agent_runs.workflow_id = workflows.id
            AND agent_runs.usage_status = 'unknown'
        ) THEN 'unknown'
        WHEN EXISTS (
          SELECT 1 FROM agent_runs
          WHERE agent_runs.workflow_id = workflows.id
            AND agent_runs.usage_status = 'partial'
        ) THEN 'partial'
        ELSE 'measured'
      END
      WHERE usage_status = 'unknown' AND status <> 'running'
    `);
  }

  private ensureAgentRunTraceColumns(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(agent_runs)")
      .all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("model")) {
      this.database.exec(
        "ALTER TABLE agent_runs ADD COLUMN model TEXT NOT NULL DEFAULT 'gpt-5.6-sol'",
      );
    }
    if (!names.has("reasoning_effort")) {
      this.database.exec(
        "ALTER TABLE agent_runs ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'high'",
      );
    }
    if (!names.has("requested_service_tier")) {
      this.database.exec(
        "ALTER TABLE agent_runs ADD COLUMN requested_service_tier TEXT NOT NULL DEFAULT 'default'",
      );
    }
    if (!names.has("effective_service_tier")) {
      this.database.exec(
        "ALTER TABLE agent_runs ADD COLUMN effective_service_tier TEXT",
      );
    }
    if (!names.has("usage_status")) {
      this.database.exec(
        "ALTER TABLE agent_runs ADD COLUMN usage_status TEXT NOT NULL DEFAULT 'unknown'",
      );
    }
    if (!names.has("error_kind")) {
      this.database.exec("ALTER TABLE agent_runs ADD COLUMN error_kind TEXT");
    }

    for (const [profile, definition] of Object.entries(modelProfiles)) {
      this.database
        .prepare(`
          UPDATE agent_runs
          SET model = ?, reasoning_effort = ?
          WHERE profile = ?
        `)
        .run(definition.model, definition.reasoningEffort, profile);
    }
    this.database.exec(`
      UPDATE agent_runs
      SET usage_status = CASE
        WHEN status = 'completed' AND usage_json IS NOT NULL THEN 'measured'
        WHEN status = 'failed' AND usage_json IS NOT NULL
          AND usage_json <> '${JSON.stringify(emptyUsage())}' THEN 'partial'
        ELSE 'unknown'
      END
      WHERE usage_status = 'unknown' AND status <> 'running'
    `);
  }
}
