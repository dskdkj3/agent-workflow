import {
  Codex,
  type CodexOptions,
  type Thread,
  type ThreadOptions,
  type ThreadEvent,
  type Usage,
} from "@openai/codex-sdk";
import { z } from "zod";

import {
  modelProfiles,
  type AgentRole,
  type AgentUsage,
  type ModelProfile,
} from "./contracts.js";

export interface AgentTurnRequest<T> {
  role: AgentRole;
  profile: ModelProfile;
  workspace: string;
  taskDir: string;
  prompt: string;
  schema: z.ZodType<T>;
  codexHome?: string;
  onThreadStarted?: (threadId: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ContinueAgentTurnRequest<T> extends AgentTurnRequest<T> {
  threadId: string;
}

export interface AgentTurnResult<T> {
  threadId: string;
  output: T;
  /** Latest cumulative usage snapshot for this Codex thread. */
  usage: AgentUsage | null;
}

export interface AgentRunner {
  start<T>(request: AgentTurnRequest<T>): Promise<AgentTurnResult<T>>;
  continue<T>(request: ContinueAgentTurnRequest<T>): Promise<AgentTurnResult<T>>;
}

export interface CodexAgentRunnerOptions {
  codexPath?: string;
  disabledMcpServerName?: string;
  configJson?: string;
}

type CodexConfig = NonNullable<CodexOptions["config"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCodexConfigJson(raw: string | undefined): CodexConfig {
  if (raw === undefined || raw.trim() === "") {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid AGENT_WORKFLOW_CODEX_CONFIG_JSON: ${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("AGENT_WORKFLOW_CODEX_CONFIG_JSON must be a JSON object");
  }
  return parsed as CodexConfig;
}

export function buildCodexBaseConfig(
  options: CodexAgentRunnerOptions = {},
): CodexConfig {
  const integrationConfig = parseCodexConfigJson(options.configJson);
  const disabledMcpServerName = options.disabledMcpServerName?.trim();

  return {
    ...integrationConfig,
    memories: {
      use_memories: false,
      generate_memories: false,
    },
    features: {
      multi_agent: false,
      multi_agent_v2: false,
    },
    model_verbosity: "high",
    model_reasoning_summary: "auto",
    ...(disabledMcpServerName
      ? {
          mcp_servers: {
            ...(isRecord(integrationConfig.mcp_servers)
              ? integrationConfig.mcp_servers
              : {}),
            // Codex validates an MCP server's transport even when it is
            // disabled. Keep a complete inert stdio transport here so the
            // backend cannot recursively invoke the outer Workflow MCP.
            [disabledMcpServerName]: {
              command: process.execPath,
              args: ["-e", "process.exit(0)"],
              enabled: false,
            },
          },
        }
      : {}),
  };
}

function normalizeUsage(usage: Usage | null): AgentUsage | null {
  if (usage === null) {
    return null;
  }

  return {
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    cache_write_input_tokens: usage.cache_write_input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_output_tokens: usage.reasoning_output_tokens,
  };
}

function parseStructuredOutput<T>(text: string, schema: z.ZodType<T>): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex returned invalid structured JSON: ${detail}`);
  }
  return schema.parse(decoded);
}

export class CodexAgentRunner implements AgentRunner {
  private readonly codexByProfile = new Map<string, Codex>();
  private readonly options: CodexAgentRunnerOptions;
  private readonly baseConfig: NonNullable<CodexOptions["config"]>;

  constructor(options: CodexAgentRunnerOptions = {}) {
    this.options = options;
    this.baseConfig = buildCodexBaseConfig(options);
  }

  async start<T>(request: AgentTurnRequest<T>): Promise<AgentTurnResult<T>> {
    const thread = this.codex(request.profile, request.codexHome).startThread(
      this.threadOptions(request),
    );
    return this.run(thread, request);
  }

  async continue<T>(
    request: ContinueAgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    const thread = this.codex(request.profile, request.codexHome).resumeThread(
      request.threadId,
      this.threadOptions(request),
    );
    return this.run(thread, request);
  }

  private threadOptions<T>(request: AgentTurnRequest<T>): ThreadOptions {
    const profile = modelProfiles[request.profile];
    return {
      model: profile.model,
      sandboxMode: "danger-full-access",
      workingDirectory: request.workspace,
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
      webSearchMode: "live",
      approvalPolicy: "never",
      additionalDirectories: [request.taskDir],
    };
  }

  private codex(profileName: ModelProfile, codexHome?: string): Codex {
    const key = `${profileName}\u0000${codexHome ?? ""}`;
    const existing = this.codexByProfile.get(key);
    if (existing) {
      return existing;
    }

    const profile = modelProfiles[profileName];
    const codex = new Codex({
      ...(this.options.codexPath
        ? { codexPathOverride: this.options.codexPath }
        : {}),
      ...(codexHome
        ? {
            env: Object.fromEntries(
              Object.entries({ ...process.env, CODEX_HOME: codexHome }).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          }
        : {}),
      config: {
        ...this.baseConfig,
        // Codex core supports the real `max` effort, while the SDK 0.147
        // ThreadOptions union still stops at `xhigh`. Passing it through the
        // generic config surface preserves the upstream effort without an
        // incorrect max -> xhigh downgrade.
        model_reasoning_effort: profile.reasoningEffort,
      },
    });
    this.codexByProfile.set(key, codex);
    return codex;
  }

  private async run<T>(
    thread: Thread,
    request: AgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    const streamed = await thread.runStreamed(request.prompt, {
      outputSchema: z.toJSONSchema(request.schema),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    let threadId = thread.id;
    let finalResponse = "";
    let usage: Usage | null = null;
    let completed = false;

    for await (const event of streamed.events) {
      await this.handleEvent(event, async (startedThreadId) => {
        threadId = startedThreadId;
        await request.onThreadStarted?.(startedThreadId);
      });
      if (
        event.type === "item.completed" &&
        event.item.type === "agent_message"
      ) {
        finalResponse = event.item.text;
      } else if (event.type === "turn.completed") {
        usage = event.usage;
        completed = true;
      } else if (event.type === "turn.failed") {
        throw new Error(`Codex turn failed: ${event.error.message}`);
      } else if (event.type === "error") {
        throw new Error(`Codex stream failed: ${event.message}`);
      }
    }

    if (threadId === null) {
      throw new Error("Codex started a turn without exposing a thread ID");
    }
    if (!completed) {
      throw new Error("Codex event stream ended before turn.completed");
    }
    if (finalResponse === "") {
      throw new Error("Codex completed a turn without an agent response");
    }

    return {
      threadId,
      output: parseStructuredOutput(finalResponse, request.schema),
      usage: normalizeUsage(usage),
    };
  }

  private async handleEvent(
    event: ThreadEvent,
    onThreadStarted: (threadId: string) => void | Promise<void>,
  ): Promise<void> {
    if (event.type === "thread.started") {
      await onThreadStarted(event.thread_id);
    }
  }
}
