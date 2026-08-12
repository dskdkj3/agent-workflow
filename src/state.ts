import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentRole,
  AgentUsage,
  ExecutionRoute,
  ModelProfile,
  WorkflowRunOutput,
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

export class StateStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        request TEXT NOT NULL,
        workspace TEXT NOT NULL,
        task_dir TEXT NOT NULL,
        execution_route TEXT NOT NULL DEFAULT 'orchestrated',
        status TEXT NOT NULL,
        summary TEXT,
        result_path TEXT,
        questions_json TEXT NOT NULL DEFAULT '[]',
        blocker TEXT,
        usage_json TEXT NOT NULL,
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
    usage: AgentUsage,
  ): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO workflows (
          id, request, workspace, task_dir, execution_route, status,
          usage_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
      `)
      .run(
        id,
        request,
        workspace,
        taskDir,
        executionRoute,
        JSON.stringify(usage),
        now,
        now,
      );
  }

  finishWorkflow(output: WorkflowRunOutput): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.database
        .prepare(`
          UPDATE workflows
          SET status = ?, summary = ?, result_path = ?, questions_json = ?, blocker = ?,
              usage_json = ?, updated_at = ?
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

  createAgentRun(input: CreateAgentRun): void {
    this.database
      .prepare(`
        INSERT INTO agent_runs (
          id, workflow_id, parent_run_id, role, profile, task_dir, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
      `)
      .run(
        input.id,
        input.workflowId,
        input.parentRunId,
        input.role,
        input.profile,
        input.taskDir,
        new Date().toISOString(),
      );
  }

  setAgentThread(runId: string, threadId: string): void {
    this.database
      .prepare("UPDATE agent_runs SET thread_id = ? WHERE id = ?")
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

  getWorkflow(id: string): Record<string, unknown> | undefined {
    return this.database
      .prepare("SELECT * FROM workflows WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
  }

  listAgentRuns(workflowId: string): Record<string, unknown>[] {
    return this.database
      .prepare("SELECT * FROM agent_runs WHERE workflow_id = ? ORDER BY started_at, id")
      .all(workflowId) as Record<string, unknown>[];
  }

  listCheckpoints(workflowId: string): Record<string, unknown>[] {
    return this.database
      .prepare(
        "SELECT * FROM checkpoints WHERE workflow_id = ? ORDER BY sequence",
      )
      .all(workflowId) as Record<string, unknown>[];
  }

  private ensureAgentRunProfileColumn(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(agent_runs)")
      .all() as { name: string }[];
    if (!columns.some((column) => column.name === "profile")) {
      // Before profile routing, every Agent used the fixed Sol high route.
      // Preserve that historical fact while making the migrated column non-null.
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
}
