# Agent Workflow

Standalone Workflow MCP controller for a minimal Codex-based agent workflow.

The current MVP intentionally exposes one synchronous tool:

```text
Interaction Agent
  -> workflow.run
  -> Orchestrator
  -> Generic Worker
  -> Orchestrator verification
  -> Interaction Agent
```

## Current boundaries

- MCP SDK `2.0.0`, protocol revision `2026-07-28`
- Codex SDK `0.147.0`
- stdio transport only
- one Worker per workflow run
- no MCP Tasks, MRTR, scheduler, durable retry engine, or persistent routing learner
- no NixOS or Home Manager installation yet

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

State defaults to `${XDG_STATE_HOME:-~/.local/state}/agent-workflow`. Override it with
`AGENT_WORKFLOW_STATE_DIR`. Override the SDK-managed Codex executable with
`AGENT_WORKFLOW_CODEX_PATH` when validating a specific runtime build. If the server
is registered in child Codex configuration, set `AGENT_WORKFLOW_MCP_SERVER_NAME` to
that registration name so child Agents cannot recursively invoke this workflow.

`npm run check` uses a fake `AgentRunner` for workflow execution and a real stdio
subprocess for the MCP `2026-07-28` handshake. It does not spend model quota.

## Current implementation limit

The TypeScript Codex SDK exposes the Codex thread ID but not the App Server turn ID.
The Controller therefore persists thread IDs, its own run IDs, and an ordered event
sequence. Journal files currently preserve only their latest contents; checkpointed
Git history and compaction hooks are not implemented yet. The first live Codex
smoke test completed correctly, but its latency and token usage were too high for
this three-Agent path to become the default daily interface without optimization.
