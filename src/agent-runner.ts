import {
  Codex,
  type CodexOptions,
  type Thread,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import { z } from "zod";

import type { AgentRole, AgentUsage } from "./contracts.js";

export interface AgentTurnRequest<T> {
  role: AgentRole;
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
  model?: string;
  disabledMcpServerName?: string;
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
  readonly model: string;
  private readonly codex: Codex;

  constructor(options: CodexAgentRunnerOptions = {}) {
    this.model = options.model ?? "gpt-5.6-sol";

    const disabledMcpServerName = options.disabledMcpServerName?.trim();
    const config: NonNullable<CodexOptions["config"]> = {
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
              [disabledMcpServerName]: { enabled: false },
            },
          }
        : {}),
    };

    this.codex = new Codex({
      ...(options.codexPath ? { codexPathOverride: options.codexPath } : {}),
      config,
    });
  }

  async start<T>(request: AgentTurnRequest<T>): Promise<AgentTurnResult<T>> {
    const thread = this.codex.startThread(this.threadOptions(request));
    return this.run(thread, request);
  }

  async continue<T>(
    request: ContinueAgentTurnRequest<T>,
  ): Promise<AgentTurnResult<T>> {
    const thread = this.codex.resumeThread(
      request.threadId,
      this.threadOptions(request),
    );
    return this.run(thread, request);
  }

  private threadOptions<T>(request: AgentTurnRequest<T>): ThreadOptions {
    return {
      model: this.model,
      sandboxMode: "danger-full-access",
      workingDirectory: request.workspace,
      skipGitRepoCheck: true,
      modelReasoningEffort: "high",
      networkAccessEnabled: true,
      webSearchMode: "live",
      approvalPolicy: "never",
      additionalDirectories: [request.taskDir],
    };
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
