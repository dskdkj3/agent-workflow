import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WebSocketServer } from "ws";

import { CodexAppServerThreadTitleReporter } from "./codex-app-server-title.js";

test("Codex app-server reporter sets the Workflow thread title over a Unix socket", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-title-"));
  const socketPath = join(root, "app-server.sock");
  const httpServer = createServer();
  const websocketServer = new WebSocketServer({ server: httpServer });
  const messages: unknown[] = [];

  websocketServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        id?: number;
        method?: string;
      };
      messages.push(message);
      if (message.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              userAgent: "codex-test",
              codexHome: root,
              platformFamily: "unix",
              platformOs: "linux",
            },
          }),
        );
      } else if (message.method === "thread/name/set") {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(root, { recursive: true, force: true });
  });

  const reporter = new CodexAppServerThreadTitleReporter({ socketPath });
  await reporter.setWorkflowStatus(
    "thread-123",
    "00000000-0000-4000-8000-000000000001",
    "running",
  );

  assert.deepEqual(messages, [
    {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "agent-workflow",
          title: "Agent Workflow",
          version: "0.1.0",
        },
      },
    },
    { method: "initialized" },
    {
      id: 2,
      method: "thread/name/set",
      params: {
        threadId: "thread-123",
        name:
          "Workflow 00000000-0000-4000-8000-000000000001 · running",
      },
    },
  ]);
});
