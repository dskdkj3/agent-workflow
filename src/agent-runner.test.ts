import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexBaseConfig, CodexAgentRunner } from "./agent-runner.js";

test("backend Agents disable Apps, plugins, Memories, and nested subagents", () => {
  const config = buildCodexBaseConfig();

  assert.deepEqual(config.features, {
    apps: false,
    plugins: false,
    multi_agent: false,
    multi_agent_v2: false,
  });
  assert.deepEqual(config.memories, {
    use_memories: false,
    generate_memories: false,
  });
});

test("disabled Workflow MCP keeps a valid inert stdio transport", () => {
  const config = buildCodexBaseConfig({
    disabledMcpServerName: "agent-workflow",
    configJson: JSON.stringify({
      mcp_servers: {
        nixos: { url: "http://127.0.0.1:8327/mcp" },
        "agent-workflow": { url: "http://127.0.0.1:9999/mcp" },
      },
    }),
  });

  assert.deepEqual(config.mcp_servers, {
    nixos: { url: "http://127.0.0.1:8327/mcp" },
    "agent-workflow": {
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      enabled: false,
    },
  });
});

test("Luna xhigh is preserved as a real Codex reasoning effort", () => {
  const runner = new CodexAgentRunner();

  assert.deepEqual(runner.configuration("luna_xhigh"), {
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
    requestedServiceTier: "default",
  });
});
