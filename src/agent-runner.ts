import {
  Codex,
  type CodexOptions,
  type Thread,
  type ThreadOptions,
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
  private readonly codexByProfile = new Map<ModelProfile, Codex>();
  private readonly options: CodexAgentRunnerOptions;
  private readonly baseConfig: NonNullable<CodexOptions["config"]>;

  constructor(options: CodexAgentRunnerOptions = {}) {
    this.options = options;

    const integrationConfig = parseCodexConfigJson(options.configJson);
    const disabledMcpServerName = options.disabledMcpServerName?.trim();
    this.baseConfig = {
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
              [disabledMcpServerName]: { enabled: false },
            },
          }
        : {}),
    };
  }

  async start<T>(request: AgentTurnRequest<T>): Promise<AgentTurnResult<T>> {
    const thread = this.codex(request.profile).startThread(
      this.threadOptions(request),
    );
    return this.run(thread, request);
  }

  async continue<T>(
    request: ContinueAgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    const thread = this.codex(request.profile).resumeThread(
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

  private codex(profileName: ModelProfile): Codex {
    const existing = this.codexByProfile.get(profileName);
    if (existing) {
      return existing;
    }

    const profile = modelProfiles[profileName];
    const codex = new Codex({
      ...(this.options.codexPath
        ? { codexPathOverride: this.options.codexPath }
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
    this.codexByProfile.set(profileName, codex);
    return codex;
  }

  private async run<T>(
    thread: Thread,
    request: AgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    const turn = await thread.run(request.prompt, {
      outputSchema: z.toJSONSchema(request.schema),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (thread.id === null) {
      throw new Error("Codex completed a turn without exposing a thread ID");
    }

    return {
      threadId: thread.id,
      output: parseStructuredOutput(turn.finalResponse, request.schema),
      usage: normalizeUsage(turn.usage),
    };
  }
}
