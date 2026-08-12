import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  emptyUsage,
  executionRouteSchema,
  modelProfileSchema,
  roleSchema,
  usageSchema,
  workflowRunOutputSchema,
  type AgentRole,
  type AgentUsage,
  type ExecutionRoute,
  type ModelProfile,
  type WorkflowRunOutput,
} from "./contracts.js";

export type AgentRunStatus = "running" | "completed" | "failed";

export interface CreateAgentRun {
  id: string;
  workflowId: string;
  parentRunId: string | null;
  role: AgentRole;
  profile: ModelProfile;
  taskDir: string;
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
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

export interface StoredAgentRun {
  id: string;
  workflowId: string;
  parentRunId: string | null;
  role: AgentRole;
  profile: ModelProfile;
  taskDir: string;
  threadId: string | null;
  status: AgentRunStatus;
  usage: AgentUsage;
  error: string | null;
}

export interface StoredEvent<T = unknown> {
  sequence: number;
  workflowId: string;
  runId: string | null;
  type: string;
  payload: T;
  createdAt: string;
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

function rowToWorkflow(row: Record<string, unknown>): StoredWorkflow {
  return {
    id: String(row.id),
    request: String(row.request),
    workspace: String(row.workspace),
    taskDir: String(row.task_dir),
    executionRoute: executionRouteSchema.parse(row.execution_route),
    completionCriteria: parseJson(row.completion_criteria_json, []),
    status: String(row.status),
    summary: row.summary === null ? null : String(row.summary),
    resultPath: row.result_path === null ? null : String(row.result_path),
    questions: parseJson(row.questions_json, []),
    blocker: row.blocker === null ? null : String(row.blocker),
    usage: parseUsage(row.usage_json),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt:
      row.lease_expires_at === null ? null : String(row.lease_expires_at),
  };
}

function rowToAgentRun(row: Record<string, unknown>): StoredAgentRun {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    parentRunId:
      row.parent_run_id === null ? null : String(row.parent_run_id),
    role: roleSchema.parse(row.role),
    profile: modelProfileSchema.parse(row.profile),
    taskDir: String(row.task_dir),
    threadId: row.thread_id === null ? null : String(row.thread_id),
    status: String(row.status) as AgentRunStatus,
    usage: parseUsage(row.usage_json),
    error: row.error === null ? null : String(row.error),
  };
}

export class StateStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA foreign_keys = ON");
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
        lease_owner TEXT,
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
        task_dir TEXT NOT NULL,
        thread_id TEXT,
        status TEXT NOT NULL,
        usage_json TEXT,
        error TEXT,
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
  }

  close(): void {
    this.database.close();
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

  finishWorkflow(output: WorkflowRunOutput): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.database
        .prepare(`
          UPDATE workflows
          SET status = ?, summary = ?, result_path = ?, questions_json = ?, blocker = ?,
              usage_json = ?, lease_owner = NULL, lease_expires_at = NULL,
              updated_at = ?
          WHERE id = ? AND status = 'running'
        `)
        .run(
          output.status,
          output.summary,
          output.result_path,
          JSON.stringify(output.questions),
          output.blocker,
          JSON.stringify(output.usage),
          new Date().toISOString(),
          output.workflow_id,
        );
      if (Number(updated.changes) !== 1) {
        const existing = this.database
          .prepare("SELECT status FROM workflows WHERE id = ?")
          .get(output.workflow_id) as { status: string } | undefined;
        if (existing === undefined) {
          throw new Error(`Unknown workflow: ${output.workflow_id}`);
        }
        throw new Error(
          `Workflow ${output.workflow_id} already has terminal outcome ${existing.status}`,
        );
      }

      this.appendEvent(output.workflow_id, null, "workflow.terminal", output);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original terminal-state failure.
      }
      throw error;
    }
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
      execution_route: workflow.executionRoute,
      retry_route: this.terminalRetryRoute(id),
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

  claimWorkflow(id: string, owner: string, leaseMs: number): boolean {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const updated = this.database
      .prepare(`
        UPDATE workflows
        SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
          AND (
            lease_owner IS NULL OR lease_owner = ? OR lease_expires_at IS NULL OR
            lease_expires_at <= ?
          )
      `)
      .run(owner, expiresAt, now.toISOString(), id, owner, now.toISOString());
    return Number(updated.changes) === 1;
  }

  heartbeatWorkflow(id: string, owner: string, leaseMs: number): boolean {
    const now = new Date();
    const updated = this.database
      .prepare(`
        UPDATE workflows
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `)
      .run(
        new Date(now.getTime() + leaseMs).toISOString(),
        now.toISOString(),
        id,
        owner,
      );
    return Number(updated.changes) === 1;
  }

  releaseWorkflow(id: string, owner: string): void {
    this.database
      .prepare(`
        UPDATE workflows
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND lease_owner = ?
      `)
      .run(new Date().toISOString(), id, owner);
  }

  updateWorkflowUsage(id: string, usage: AgentUsage): void {
    this.database
      .prepare(`
        UPDATE workflows
        SET usage_json = ?, updated_at = ?
        WHERE id = ? AND status = 'running'
      `)
      .run(JSON.stringify(usage), new Date().toISOString(), id);
  }

  updateAgentUsage(runId: string, usage: AgentUsage): void {
    this.database
      .prepare(`
        UPDATE agent_runs
        SET usage_json = ?
        WHERE id = ? AND status = 'running'
      `)
      .run(JSON.stringify(usage), runId);
  }

  recordAgentProgress(
    runId: string,
    usage: AgentUsage,
    eventType: string,
    payload: unknown,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare("SELECT workflow_id FROM agent_runs WHERE id = ?")
        .get(runId) as { workflow_id: string } | undefined;
      if (row === undefined) {
        throw new Error(`Unknown agent run: ${runId}`);
      }
      this.updateAgentUsage(runId, usage);
      this.appendEvent(row.workflow_id, runId, eventType, payload);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original progress failure.
      }
      throw error;
    }
  }

  createAgentRun(input: CreateAgentRun): void {
    this.database
      .prepare(`
        INSERT INTO agent_runs (
          id, workflow_id, parent_run_id, role, profile, task_dir, status,
          usage_json, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `)
      .run(
        input.id,
        input.workflowId,
        input.parentRunId,
        input.role,
        input.profile,
        input.taskDir,
        JSON.stringify(emptyUsage()),
        new Date().toISOString(),
      );
  }

  setAgentThread(runId: string, threadId: string): void {
    this.database
      .prepare(`
        UPDATE agent_runs
        SET thread_id = ?
        WHERE id = ? AND status = 'running'
      `)
      .run(threadId, runId);
  }

  finishAgentRun(
    runId: string,
    status: AgentRunStatus,
    usage: AgentUsage,
    error: string | null = null,
  ): void {
    this.database
      .prepare(`
        UPDATE agent_runs
        SET status = ?, usage_json = ?, error = ?, completed_at = ?
        WHERE id = ?
      `)
      .run(status, JSON.stringify(usage), error, new Date().toISOString(), runId);
  }

  completeAgentRun(
    runId: string,
    usage: AgentUsage,
    eventType: string,
    payload: unknown,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare("SELECT workflow_id FROM agent_runs WHERE id = ?")
        .get(runId) as { workflow_id: string } | undefined;
      if (row === undefined) {
        throw new Error(`Unknown agent run: ${runId}`);
      }
      this.database
        .prepare(`
          UPDATE agent_runs
          SET status = 'completed', usage_json = ?, error = NULL,
              completed_at = ?
          WHERE id = ?
        `)
        .run(JSON.stringify(usage), new Date().toISOString(), runId);
      this.appendEvent(row.workflow_id, runId, eventType, payload);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original completion failure.
      }
      throw error;
    }
  }

  appendEvent(
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

  recordCheckpoint(
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
}
