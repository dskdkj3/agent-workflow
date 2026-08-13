import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";

import {
  workflowRunOutputSchema,
  type WorkflowRunOutput,
} from "./contracts.js";
import {
  createWorkflowMcpServer,
  type WorkflowService,
} from "./server.js";

function workflowOutput(
  overrides: Partial<WorkflowRunOutput> = {},
): WorkflowRunOutput {
  return workflowRunOutputSchema.parse({
    workflow_id: "00000000-0000-4000-8000-000000000001",
    status: "completed",
    summary: "Workflow completed",
    task_dir: "/tmp/agent-workflow-test/task",
    result_path: "/tmp/agent-workflow-test/task/orchestrator/result.md",
    questions: [],
    blocker: null,
    execution_route: "orchestrated",
    retry_route: null,
    usage_status: "measured",
    failure_kind: null,
    recovery_requires_user_approval: false,
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
    ...overrides,
  });
}

function testStdioProtocol(
  protocolVersion: "2025-06-18" | "2026-07-28",
  era: "Legacy" | "Modern",
): void {
  test(
    `stdio entry negotiates MCP ${protocolVersion} and lists workflow.run`,
    { timeout: 20_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-workflow-stdio-"));
      const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));
      const projectDir = dirname(dirname(serverPath));
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        cwd: projectDir,
        env: {
          ...getDefaultEnvironment(),
          AGENT_WORKFLOW_STATE_DIR: join(root, "state"),
        },
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      const client = new Client(
        {
          name: `agent-workflow-${era.toLowerCase()}-test`,
          version: "0.1.0",
        },
        {
          supportedProtocolVersions: [protocolVersion],
          versionNegotiation:
            protocolVersion === "2025-06-18"
              ? { mode: "legacy" }
              : {
                  mode: { pin: protocolVersion },
                  probe: { timeoutMs: 5_000 },
                },
        },
      );

      try {
        await client.connect(transport);
        assert.equal(client.getNegotiatedProtocolVersion(), protocolVersion);
        const listed = await client.listTools();
        assert.ok(listed.tools.some((tool) => tool.name === "workflow.run"));
      } catch (error) {
        const detail = error instanceof Error ? error.stack : String(error);
        throw new Error(
          `${era} stdio MCP check failed: ${detail}\n${stderr}`,
        );
      } finally {
        await client.close().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test("workflow.run exposes and returns validated structured output", async (t) => {
  const calls: unknown[] = [];
  const service: WorkflowService = {
    async run(input) {
      calls.push(input);
      if (input.request === "fail") {
        return workflowOutput({
          status: "failed",
          summary: "Synthetic failure",
          result_path: null,
          blocker: "Synthetic failure",
          failure_kind: "execution_error",
        });
      }
      return workflowOutput();
    },
    recordRecoveryDecision(input) {
      return {
        workflow_id: input.workflow_id,
        decision_id: input.decision_id,
        decision: input.decision,
        recorded_at: "2026-08-12T00:00:00.000Z",
      };
    },
  };
  const server = createWorkflowMcpServer(service);
  const client = new Client({ name: "agent-workflow-test", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === "workflow.run");
  assert.ok(tool);
  assert.ok(tool.inputSchema);
  assert.ok(tool.outputSchema);
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.idempotentHint, false);

  const recoveryTool = listed.tools.find(
    (candidate) => candidate.name === "workflow.recovery_decision",
  );
  assert.ok(recoveryTool);
  assert.equal(recoveryTool.annotations?.idempotentHint, true);

  const result = await client.callTool({
    name: "workflow.run",
    arguments: {
      request: "run fixture",
      workspace: "/tmp/workspace",
    },
  });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, workflowOutput());
  assert.deepEqual(calls, [
    {
      request: "run fixture",
      workspace: "/tmp/workspace",
      execution_route: "orchestrated",
      completion_criteria: [],
    },
  ]);
  assert.ok(
    result.content.some(
      (block) =>
        block.type === "text" && block.text.includes("Workflow completed"),
    ),
  );

  const failed = await client.callTool({
    name: "workflow.run",
    arguments: { request: "fail" },
  });
  assert.equal(failed.isError, true);
  assert.deepEqual(
    failed.structuredContent,
    workflowOutput({
      status: "failed",
      summary: "Synthetic failure",
      result_path: null,
      blocker: "Synthetic failure",
      failure_kind: "execution_error",
    }),
  );

  const recovery = await client.callTool({
    name: "workflow.recovery_decision",
    arguments: {
      workflow_id: "00000000-0000-4000-8000-000000000001",
      decision_id: "00000000-0000-4000-8000-000000000002",
      decision: "approved",
    },
  });
  assert.notEqual(recovery.isError, true);
  assert.deepEqual(recovery.structuredContent, {
    workflow_id: "00000000-0000-4000-8000-000000000001",
    decision_id: "00000000-0000-4000-8000-000000000002",
    decision: "approved",
    recorded_at: "2026-08-12T00:00:00.000Z",
  });
});

testStdioProtocol("2025-06-18", "Legacy");
testStdioProtocol("2026-07-28", "Modern");
