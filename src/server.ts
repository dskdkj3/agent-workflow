#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { CodexAgentRunner } from "./agent-runner.js";
import {
  CodexAppServerThreadTitleReporter,
  defaultCodexAppServerSocketPath,
  type WorkflowTitleReporter,
  type WorkflowTitleStatus,
} from "./codex-app-server-title.js";
import { WorkflowController } from "./controller.js";
import { defaultStateDir } from "./state-path.js";
import {
  workflowRunInputSchema,
  workflowRunOutputSchema,
  recoveryDecisionInputSchema,
  recoveryDecisionOutputSchema,
  type RecoveryDecisionInput,
  type RecoveryDecisionOutput,
  type WorkflowRunInput,
  type WorkflowRunOutput,
} from "./contracts.js";

export interface WorkflowService {
  run(input: WorkflowRunInput, signal?: AbortSignal): Promise<WorkflowRunOutput>;
  recordRecoveryDecision(
    input: RecoveryDecisionInput,
  ): RecoveryDecisionOutput | Promise<RecoveryDecisionOutput>;
}

export interface WorkflowMcpServerOptions {
  titleReporter?: WorkflowTitleReporter;
  warn?: (message: string) => void;
}

function requestThreadId(meta: Record<string, unknown> | undefined): string | null {
  const threadId = meta?.threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : null;
}

async function reportWorkflowTitle(
  reporter: WorkflowTitleReporter | undefined,
  warn: (message: string) => void,
  threadId: string | null,
  workflowId: string,
  status: WorkflowTitleStatus,
): Promise<void> {
  if (reporter === undefined || threadId === null) {
    return;
  }
  try {
    await reporter.setWorkflowStatus(threadId, workflowId, status);
  } catch (error) {
    warn(
      `failed to update Codex Workflow title for ${workflowId}: ${String(error)}`,
    );
  }
}

export function createWorkflowMcpServer(
  service: WorkflowService,
  options: WorkflowMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "agent-workflow",
    version: "0.1.0",
  });
  const warn =
    options.warn ??
    ((message: string) => {
      process.stderr.write(`[agent-workflow] warning: ${message}\n`);
    });

  server.registerTool(
    "workflow.run",
    {
      title: "Run agent workflow",
      description:
        "Run one synchronous workflow through either the full Orchestrator route or an explicitly selected single-Worker fast path; both routes persist checkpoints and require independent verification before completion.",
      inputSchema: workflowRunInputSchema,
      outputSchema: workflowRunOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      const workflowId = input.workflow_id ?? randomUUID();
      const threadId = requestThreadId(context.mcpReq._meta);
      await reportWorkflowTitle(
        options.titleReporter,
        warn,
        threadId,
        workflowId,
        "running",
      );
      let result: WorkflowRunOutput;
      try {
        result = await service.run(
          { ...input, workflow_id: workflowId },
          context.mcpReq.signal,
        );
      } catch (error) {
        await reportWorkflowTitle(
          options.titleReporter,
          warn,
          threadId,
          workflowId,
          "failed",
        );
        throw error;
      }
      await reportWorkflowTitle(
        options.titleReporter,
        warn,
        threadId,
        workflowId,
        result.status,
      );
      return {
        content: [
          {
            type: "text",
            text:
              `${result.summary}\n\n` +
              `Workflow: ${result.workflow_id}\n` +
              `Artifacts: ${result.task_dir}`,
          },
        ],
        structuredContent: result,
        isError: result.status === "failed",
      };
    },
  );

  server.registerTool(
    "workflow.recovery_decision",
    {
      title: "Record workflow recovery decision",
      description:
        "Record the user's explicit approval or denial of a semantically different recovery after a cyber_policy failure. This tool never retries or changes the failed workflow.",
      inputSchema: recoveryDecisionInputSchema,
      outputSchema: recoveryDecisionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await service.recordRecoveryDecision(input);
      return {
        content: [
          {
            type: "text",
            text:
              `Recovery decision ${result.decision} recorded for ` +
              `${result.workflow_id}.`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const runner = new CodexAgentRunner({
    ...(process.env.AGENT_WORKFLOW_CODEX_PATH
      ? { codexPath: process.env.AGENT_WORKFLOW_CODEX_PATH }
      : {}),
    ...(process.env.AGENT_WORKFLOW_MCP_SERVER_NAME
      ? {
          disabledMcpServerName:
            process.env.AGENT_WORKFLOW_MCP_SERVER_NAME,
        }
      : {}),
    ...(process.env.AGENT_WORKFLOW_CODEX_CONFIG_JSON
      ? { configJson: process.env.AGENT_WORKFLOW_CODEX_CONFIG_JSON }
      : {}),
  });
  const controller = new WorkflowController({
    stateDir: defaultStateDir(),
    runner,
  });
  const titleReporter = process.env.CODEX_HOME
    ? new CodexAppServerThreadTitleReporter({
        socketPath: defaultCodexAppServerSocketPath(process.env.CODEX_HOME),
      })
    : undefined;
  const handle = serveStdio(
    () =>
      createWorkflowMcpServer(controller, {
        ...(titleReporter === undefined ? {} : { titleReporter }),
      }),
    {
      legacy: "serve",
      onerror: (error) => {
        process.stderr.write(`[agent-workflow] MCP error: ${error.message}\n`);
      },
    },
  );

  const shutdown = async (): Promise<void> => {
    await handle.close();
    controller.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath !== null && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error: unknown) => {
    process.stderr.write(`[agent-workflow] fatal: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
