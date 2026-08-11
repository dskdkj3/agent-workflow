import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexBaseConfig } from "./agent-runner.js";

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
