import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import WebSocket from "ws";

export type WorkflowTitleStatus =
  | "running"
  | "completed"
  | "needs_input"
  | "blocked"
  | "failed"
  | "cancelled";

export interface WorkflowTitleReporter {
  setWorkflowStatus(
    threadId: string,
    workflowId: string,
    status: WorkflowTitleStatus,
  ): Promise<void>;
}

export interface CodexAppServerThreadTitleReporterOptions {
  socketPath: string;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

const INITIALIZE_REQUEST_ID = 1;
const SET_NAME_REQUEST_ID = 2;
const DEFAULT_TIMEOUT_MS = 2_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseResponse(data: WebSocket.RawData): JsonRpcResponse | null {
  try {
    const parsed: unknown = JSON.parse(data.toString());
    return typeof parsed === "object" && parsed !== null
      ? (parsed as JsonRpcResponse)
      : null;
  } catch {
    return null;
  }
}

function assertSuccessfulResponse(
  response: JsonRpcResponse,
  requestId: number,
  method: string,
): void {
  if (response.id !== requestId) {
    throw new Error(`Unexpected response ID while calling ${method}`);
  }
  if (response.error !== undefined) {
    const code = response.error.code ?? "unknown";
    const message = response.error.message ?? "unknown error";
    throw new Error(`${method} failed (${String(code)}): ${String(message)}`);
  }
}

export function defaultCodexAppServerSocketPath(codexHome: string): string {
  return join(codexHome, "app-server-control", "app-server-control.sock");
}

export class CodexAppServerThreadTitleReporter
  implements WorkflowTitleReporter
{
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: CodexAppServerThreadTitleReporterOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async setWorkflowStatus(
    threadId: string,
    workflowId: string,
    status: WorkflowTitleStatus,
  ): Promise<void> {
    if (!existsSync(this.socketPath)) {
      throw new Error(
        `Codex app-server socket is unavailable: ${this.socketPath}`,
      );
    }

    const websocket = new WebSocket("ws://localhost/", {
      createConnection: () => createConnection(this.socketPath),
      handshakeTimeout: this.timeoutMs,
      perMessageDeflate: false,
    });

    await new Promise<void>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = setTimeout(() => {
        websocket.terminate();
        reject(
          new Error(
            `Timed out updating Codex thread title through ${this.socketPath}`,
          ),
        );
      }, this.timeoutMs);
      timeout.unref();

      let initialized = false;
      let settled = false;

      const finish = (error?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== null) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (websocket.readyState === WebSocket.OPEN) {
          websocket.close();
        } else if (websocket.readyState !== WebSocket.CLOSED) {
          websocket.terminate();
        }
        if (error === undefined) {
          resolve();
        } else {
          reject(error instanceof Error ? error : new Error(errorMessage(error)));
        }
      };

      websocket.once("error", finish);
      websocket.once("open", () => {
        websocket.send(
          JSON.stringify({
            id: INITIALIZE_REQUEST_ID,
            method: "initialize",
            params: {
              clientInfo: {
                name: "agent-workflow",
                title: "Agent Workflow",
                version: "0.1.0",
              },
            },
          }),
        );
      });
      websocket.on("message", (data) => {
        const response = parseResponse(data);
        if (response === null || response.id === undefined) {
          return;
        }
        try {
          if (!initialized) {
            assertSuccessfulResponse(
              response,
              INITIALIZE_REQUEST_ID,
              "initialize",
            );
            initialized = true;
            websocket.send(JSON.stringify({ method: "initialized" }));
            websocket.send(
              JSON.stringify({
                id: SET_NAME_REQUEST_ID,
                method: "thread/name/set",
                params: {
                  threadId,
                  name: `Workflow ${workflowId} · ${status}`,
                },
              }),
            );
            return;
          }

          assertSuccessfulResponse(
            response,
            SET_NAME_REQUEST_ID,
            "thread/name/set",
          );
          finish();
        } catch (error) {
          finish(error);
        }
      });
      websocket.once("close", () => {
        if (!settled) {
          finish(new Error("Codex app-server closed before title update"));
        }
      });
    });
  }
}
