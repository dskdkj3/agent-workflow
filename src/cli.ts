#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultStateDir } from "./state-path.js";
import { formatWorkflowTrace } from "./trace-format.js";
import { loadWorkflowTrace } from "./trace.js";
import { startTraceWebViewer } from "./trace-web.js";

interface TraceArguments {
  mode: "text" | "json" | "follow" | "web";
  workflowId: string | "latest";
}

function usage(): string {
  return `Usage:
  agent-workflow trace latest
  agent-workflow trace <workflow-id>
  agent-workflow trace --follow <workflow-id|latest>
  agent-workflow trace --json <workflow-id|latest>
  agent-workflow trace --web <workflow-id|latest>
`;
}

function parseArguments(argv: string[]): TraceArguments {
  if (argv[0] !== "trace") {
    throw new Error(usage());
  }
  const rest = argv.slice(1);
  let mode: TraceArguments["mode"] = "text";
  let workflowId: string | "latest" | null = null;
  for (const argument of rest) {
    if (argument === "--json" || argument === "--follow" || argument === "--web") {
      if (mode !== "text") {
        throw new Error("Select only one of --json, --follow, or --web");
      }
      mode = argument.slice(2) as TraceArguments["mode"];
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (workflowId !== null) {
      throw new Error("Trace accepts exactly one workflow ID or latest");
    }
    workflowId = argument;
  }
  return { mode, workflowId: workflowId ?? "latest" };
}

function openBrowser(url: string): void {
  const child = spawn("xdg-open", [url], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
}

async function followTrace(
  stateDir: string,
  workflowId: string | "latest",
): Promise<void> {
  let revision: string | null = null;
  while (true) {
    const trace = loadWorkflowTrace(stateDir, workflowId);
    if (trace.revision !== revision) {
      if (revision !== null) {
        process.stdout.write("\n--- trace updated ---\n\n");
      }
      process.stdout.write(formatWorkflowTrace(trace));
      revision = trace.revision;
    }
    await new Promise<void>((resolvePromise) => {
      const interrupted = (): void => {
        clearTimeout(timer);
        process.exitCode = 130;
        resolvePromise();
      };
      const timer = setTimeout(() => {
        process.off("SIGINT", interrupted);
        resolvePromise();
      }, 1000);
      process.once("SIGINT", interrupted);
    });
    if (process.exitCode === 130) {
      return;
    }
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(argv);
  const stateDir = defaultStateDir();
  const initial = loadWorkflowTrace(stateDir, parsed.workflowId);
  const workflowId = initial.workflow.id;
  if (parsed.mode === "json") {
    process.stdout.write(`${JSON.stringify(initial, null, 2)}\n`);
    return;
  }
  if (parsed.mode === "follow") {
    await followTrace(stateDir, workflowId);
    return;
  }
  if (parsed.mode === "web") {
    const viewer = await startTraceWebViewer({
      load: () => loadWorkflowTrace(stateDir, workflowId),
    });
    process.stdout.write(`Workflow Trace: ${viewer.url}\n`);
    openBrowser(viewer.url);
    const stop = async (): Promise<void> => {
      await viewer.close();
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    return new Promise<void>((resolvePromise) => {
      viewer.server.once("close", resolvePromise);
    });
  }
  process.stdout.write(formatWorkflowTrace(initial));
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath !== null && fileURLToPath(import.meta.url) === entryPath) {
  runCli().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
