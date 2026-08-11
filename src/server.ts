#!/usr/bin/env node

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { CodexAgentRunner } from "./agent-runner.js";
import { WorkflowController } from "./controller.js";
import {
  workflowRunInputSchema,
  workflowRunOutputSchema,
  type WorkflowRunInput,
  type WorkflowRunOutput,
} from "./contracts.js";

export interface WorkflowService {
  run(input: WorkflowRunInput, signal?: AbortSignal): Promise<WorkflowRunOutput>;
}

export function createWorkflowMcpServer(service: WorkflowService): McpServer {
  const server = new McpServer({
    name: "agent-workflow",
    version: "0.1.0",
  });

  server.registerTool(
    "workflow.run",
    {
      title: "Run agent workflow",
      description:
        "Run one synchronous workflow through a Sol Orchestrator, one routed Generic Worker, an independent Verifier, and final Orchestrator judgment.",
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
      const result = await service.run(input, context.mcpReq.signal);
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

  return server;
}

function defaultStateDir(): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return resolve(
    process.env.AGENT_WORKFLOW_STATE_DIR ?? join(stateHome, "agent-workflow"),
  );
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
  const handle = serveStdio(() => createWorkflowMcpServer(controller), {
    legacy: "serve",
    onerror: (error) => {
      process.stderr.write(`[agent-workflow] MCP error: ${error.message}\n`);
    },
  });

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
