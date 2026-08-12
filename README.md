# Agent Workflow

Standalone Workflow MCP controller for a minimal Codex-based agent workflow.

The current MVP intentionally exposes one synchronous tool with two routes:

```text
Interaction Agent
  -> workflow.run
  -> single Worker -> independent Verifier; or
  -> Orchestrator -> Generic Worker -> independent Verifier -> Orchestrator judgment
  -> Interaction Agent
```

## Current boundaries

- MCP SDK `2.0.0`, modern protocol revision `2026-07-28`, with stdio compatibility for Codex clients using the `2025-06-18` initialize handshake
- Codex SDK `0.147.0`
- stdio transport only
- one Worker and one independent Verifier per completed workflow run
- allowlisted model routes: `luna_max`, `terra_high`, `sol_high`, `sol_max`
- Orchestrator uses `sol_high`; it chooses Worker and Verifier routes from the residual cognitive burden
- the explicit `single_worker` route uses `luna_max` for both the bounded Worker and mechanical independent Verifier
- semantic Journal checkpoints are committed by the Controller to one local, non-project Git repository per workflow
- an interrupted Controller invocation can resume the original Workflow Run by reusing its caller-generated `workflow_id`
- no MCP Tasks, MRTR, scheduler, general retry engine, or persistent routing learner
- standalone Nix package for the internal `agent-workflow-mcp` server; host integration remains external

## Tool

`workflow.run` accepts a normalized request from the Interaction Agent:

```json
{
  "workflow_id": "de305d54-75b4-431b-adb2-eb6b9e546014",
  "request": "Implement and verify the requested change",
  "workspace": "/absolute/path/to/workspace",
  "execution_route": "single_worker",
  "completion_criteria": ["The requested behavior is observable and its focused test passes"]
}
```

The Interaction Agent should generate a UUID before the first call and pass it as
`workflow_id`. If the MCP transport or Controller process disappears, retry the
identical request, workspace, route, and completion criteria with the same ID.
The Controller resumes persisted Codex threads and artifacts. If that Workflow is
already terminal, the retry returns the original Terminal Outcome without another
model call. Reusing an ID with different immutable input is rejected, and a SQLite
lease prevents two Controllers from advancing the same Workflow concurrently.

Omit `execution_route` and `completion_criteria` to use the default Orchestrator
route. `single_worker` is accepted only with at least one observable completion
criterion. If the Worker requests escalation or the independent Verifier rejects the
result, `retry_route` is set to `orchestrated` so the Interaction Agent can retry
without asking the user to coordinate the correction.

It returns a structured terminal outcome and paths to the persisted task artifacts.
The `usage` object sums the latest cumulative SDK usage snapshot for each Agent
thread. A resumed Orchestrator's latest snapshot replaces its earlier planning
snapshot. Repeated tool rounds therefore increase `input_tokens` even when much of
the context is cached; this measures cumulative model processing, not unique context
size.

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

Mutable task artifacts live under `tasks/<workflow-id>/`. Their version history
lives separately under `checkpoints/<workflow-id>.git`; the Controller commits only
`task.md`, `journal.md`, and `result.md` at semantic workflow boundaries. Workspace
repositories are never used for Journal history. A non-Nix installation therefore
requires `git` in `PATH`; the Nix package supplies it internally.
On `single_worker`, the Controller can materialize the Agent's structured terminal
outcome into its final Journal and result, avoiding model tool rounds whose only
purpose would be to duplicate the same content before the completion checkpoint.

Each Agent also has a persistent isolated Codex home under
`codex-homes/<workflow-id>/<agent-run-id>/`. The Controller records the Codex thread
ID as soon as `thread.started` arrives and resumes that thread after an interruption.
Before Codex compacts a thread, a trusted `PreCompact` hook commits the latest Task
and Journal without treating a newly written unfinished result as final. The compact
`SessionStart` hook reloads the complete Task and Journal. Codex itself preserves the
startup user-level and project-level `AGENTS.md` instruction chain across compaction,
so the hook does not duplicate those instructions.

`npm run check` uses a fake `AgentRunner` for workflow execution and real stdio
subprocesses for the MCP `2025-06-18` and `2026-07-28` handshakes. It does not
spend model quota.

## Current implementation limits

The TypeScript Codex SDK exposes the Codex thread ID but not the App Server turn ID.
The Controller therefore persists thread IDs, its own run IDs, an ordered event
sequence, and the Git commit ID for every semantic Journal checkpoint. It resumes the
thread and asks the Agent to reconcile the current workspace, so interrupted commands
or edits may already have taken effect and must not be replayed blindly. Detailed
Worker and Verifier evidence stays in workspace and task artifacts; the final
Orchestrator prompt receives compact structured outcomes and artifact paths instead
of Agent conversation history.

The SDK `0.147.0` TypeScript `ThreadOptions` union does not yet include the real
`max` effort. This project passes `model_reasoning_effort="max"` through the generic
Codex config surface for `luna_max` and `sol_max`; it never downgrades `max` to
`xhigh`.

The repository also contains a Codex plugin manifest and the Interaction skill at
`skills/use-agent-workflow/`. Daily wrapper and Home Manager wiring remain outside
this repository.
