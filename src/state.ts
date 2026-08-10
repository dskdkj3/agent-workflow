import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentRole, AgentUsage, WorkflowRunOutput } from "./contracts.js";

export type AgentRunStatus = "running" | "completed" | "failed";

export interface CreateAgentRun {
  id: string;
  workflowId: string;
  parentRunId: string | null;
  role: AgentRole;
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
    `);
  }

  close(): void {
    this.database.close();
  }

  createWorkflow(
    id: string,
    request: string,
    workspace: string,
    taskDir: string,
    usage: AgentUsage,
  ): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO workflows (
          id, request, workspace, task_dir, status, usage_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
      `)
      .run(id, request, workspace, taskDir, JSON.stringify(usage), now, now);
  }

  finishWorkflow(output: WorkflowRunOutput): void {
    this.database
      .prepare(`
        UPDATE workflows
        SET status = ?, summary = ?, result_path = ?, questions_json = ?, blocker = ?,
            usage_json = ?, updated_at = ?
        WHERE id = ?
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
  }

  createAgentRun(input: CreateAgentRun): void {
    this.database
      .prepare(`
        INSERT INTO agent_runs (
          id, workflow_id, parent_run_id, role, task_dir, status, started_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?)
      `)
      .run(
        input.id,
        input.workflowId,
        input.parentRunId,
        input.role,
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
}
