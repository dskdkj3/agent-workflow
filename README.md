# Agent Workflow

Standalone Workflow MCP controller for a minimal Codex-based agent workflow.

The current MVP intentionally exposes one synchronous tool:

```text
Interaction Agent
  -> workflow.run
  -> Orchestrator
  -> Generic Worker
  -> independent Verifier
  -> Orchestrator judgment
  -> Interaction Agent
```

## Current boundaries

- MCP SDK `2.0.0`, modern protocol revision `2026-07-28`, with stdio compatibility for Codex clients using the `2025-06-18` initialize handshake
- Codex SDK `0.147.0`
- stdio transport only
- one Worker and one independent Verifier per completed workflow run
- allowlisted model routes: `luna_max`, `terra_high`, `sol_high`, `sol_max`
- Orchestrator uses `sol_high`; it chooses Worker and Verifier routes from the residual cognitive burden
- no MCP Tasks, MRTR, scheduler, durable retry engine, or persistent routing learner
- standalone Nix package for the internal `agent-workflow-mcp` server; host integration remains external

## Tool

`workflow.run` accepts a normalized request from the Interaction Agent:

```json
{
  "request": "Implement and verify the requested change",
  "workspace": "/absolute/path/to/workspace"
}
```

It returns a structured terminal outcome and paths to the persisted task artifacts.

`needs_input` is terminal for the current synchronous invocation. The Interaction
Agent should discuss the questions with the user, then start a new `workflow.run`
with the clarified request.

Because one call can contain a complete coding task, MCP clients must configure a
tool timeout longer than their normal short-tool default (for example,
`tool_timeout_sec = 3600`).

## Development

```bash
npm install
npm run check
npm start
```

The flake default package installs the internal stdio server:

```bash
nix build
./result/bin/agent-workflow-mcp
```

State defaults to `${XDG_STATE_HOME:-~/.local/state}/agent-workflow`. Override it with
`AGENT_WORKFLOW_STATE_DIR`. Override the SDK-managed Codex executable with
`AGENT_WORKFLOW_CODEX_PATH` when validating a specific runtime build. If the server
is registered in child Codex configuration, set `AGENT_WORKFLOW_MCP_SERVER_NAME` to
that registration name so child Agents cannot recursively invoke this workflow.
Host integrations may pass provider-specific Codex settings through
`AGENT_WORKFLOW_CODEX_CONFIG_JSON`; keep secrets out of that JSON and reference an
inherited environment variable with the provider's `env_key` instead.

`npm run check` uses a fake `AgentRunner` for workflow execution and real stdio
subprocesses for the MCP `2025-06-18` and `2026-07-28` handshakes. It does not
spend model quota.

## Current implementation limit

The TypeScript Codex SDK exposes the Codex thread ID but not the App Server turn ID.
The Controller therefore persists thread IDs, its own run IDs, and an ordered event
sequence. Journal files currently preserve only their latest contents; checkpointed
history and compaction hooks are not implemented yet. Detailed Worker and Verifier
evidence stays in workspace and task artifacts; the final Orchestrator prompt receives
compact structured outcomes and artifact paths instead of Agent conversation history.

The SDK `0.147.0` TypeScript `ThreadOptions` union does not yet include the real
`max` effort. This project passes `model_reasoning_effort="max"` through the generic
Codex config surface for `luna_max` and `sol_max`; it never downgrades `max` to
`xhigh`.

The repository also contains a Codex plugin manifest and the Interaction skill at
`skills/use-agent-workflow/`. Daily wrapper and Home Manager wiring remain outside
this repository.
