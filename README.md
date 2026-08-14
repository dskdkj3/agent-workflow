# Agent Workflow

Standalone Workflow MCP controller and trace viewer for a minimal Codex-based agent workflow.

The current MVP exposes one synchronous execution tool with two routes, plus a narrow recorder for explicit recovery decisions:

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
- MCP tools: `workflow.run` and `workflow.recovery_decision`
- one Worker and one independent Verifier per completed workflow run
- allowlisted model routes: `luna_high`, `luna_xhigh`, `luna_max`, `terra_high`, `sol_high`, `sol_max`
- Orchestrator uses `sol_high`; it classifies residual Worker and Verifier task shape, then the Controller applies a fixed, auditable profile mapping
- the explicit `single_worker` route uses `luna_high` for both the bounded Worker and mechanical independent Verifier
- backend Agents explicitly disable Codex Apps, Memories, and nested subagents
- semantic Journal checkpoints are committed by the Controller to one local, non-project Git repository per workflow
- an interrupted Controller invocation restores active Task and Journal content from the last authoritative complete Checkpoint before resuming the original Workflow Run
- monotonic lease epochs fence superseded Controllers, late Agent turns, and stale lifecycle hooks
- caller cancellation is fenced again after every Agent turn, even when a Runner ignores or races its `AbortSignal`
- Agent-authored long reports are preserved inside a Controller-attested final result instead of being replaced by a short structured summary
- `passed` Verification requires at least one durable Evidence Reference to an existing regular file inside the Workspace or Workflow task directory
- one authoritative Workflow Trace powers text, JSON, follow, and loopback-only Web views
- when the caller exposes the same Codex app-server Unix socket and supplies its
  thread ID in MCP request metadata, the server best-effort names that thread
  `Workflow <workflow-id> · <status>` for statusline display
- no MCP Tasks, MRTR, scheduler, general retry engine, or persistent routing learner
- standalone Nix package for the internal `agent-workflow-mcp` server; host integration remains external

## Routing policy

The reference implementation treats model family and reasoning effort as separate
decisions. Model family follows residual ambiguity, breadth, knowledge, and judgment;
reasoning effort follows task horizon, feedback strength, and iteration depth.
The Orchestrator emits a task class and rationale rather than a free-form model name:

| Task class | Controller profile | Intended residual task |
| --- | --- | --- |
| `short_bounded` | `luna_high` | narrow execution with explicit feedback |
| `bounded_execution` | `luna_xhigh` | ordinary multi-step execution with a strong oracle |
| `long_horizon_execution` | `luna_max` | difficult or long execution that remains bounded and strongly verifiable |
| `bounded_judgment` | `terra_high` | clear research or evidence judgment without a mechanical oracle |
| `irreducible_synthesis` | `sol_high` | inseparable cross-system synthesis after real decomposition |
| `critical_deliberation` | `sol_max` | system-defining, high-consequence judgment where Sol high is specifically insufficient |

Verifier classes map separately: `mechanical_check` to `luna_high`,
`bounded_evidence_review` to `terra_high`, `irreducible_review` to `sol_high`,
and `critical_review` to `sol_max`. A Verifier does not inherit the Worker route merely
because the topic sounds important.

Every new routed plan records the residual burden, why a lower-cost route is
insufficient, and the condition that would require escalation. These facts are part
of the authoritative Workflow Trace. Plans created by older releases remain
resumable and show `legacy_unknown` instead of receiving an invented rationale.

The bounded-execution effort choices are calibrated against the current
[DeepSWE v1.1 curve](https://deepswe.datacurve.ai/blog/deepswe-v1-1), not copied from
its leaderboard. DeepSWE is a long-horizon coding benchmark with executable
verification; it is not evidence about user-intent interpretation, open-ended
research, architecture discussion, or safety review. Those roles require local
workflow evaluations.

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

If an upstream turn is classified as `cyber_policy`, the Workflow stops with
`recovery_requires_user_approval=true` and `retry_route=null`. The Interaction
Agent must ask whether the user approves a semantically different recovery. It
then records the approval or denial on the failed Workflow with
`workflow.recovery_decision`; this recorder does not retry or mutate the failed
run. An approved recovery starts as a new Workflow Run with a new ID.

It returns a structured terminal outcome and paths to the persisted task artifacts.
The `usage` object sums the latest cumulative SDK usage snapshot for each Agent
thread. `usage_status` distinguishes `measured`, `estimated`, `partial`, and
`unknown`; when usage is unknown, `usage` is `null` rather than a numeric zero
placeholder. A resumed
Orchestrator's latest snapshot replaces its earlier planning snapshot. Repeated
tool rounds therefore increase `input_tokens` even when much of the context is
cached; this measures cumulative model processing, not unique context size.

`needs_input` is terminal for the current synchronous invocation. The Interaction
Agent should discuss the questions with the user, then start a new `workflow.run`
with the clarified request.

Because one call can contain a complete coding task, MCP clients must configure a
tool timeout longer than their normal short-tool default (for example,
`tool_timeout_sec = 3600`).

## Workflow Trace

All trace views consume the same read-only projection:

```bash
agent-workflow trace latest
agent-workflow trace <workflow-id>
agent-workflow trace --follow <workflow-id>
agent-workflow trace --json <workflow-id>
agent-workflow trace --web <workflow-id>
```

The Trace includes route, route-class rationale and upgrade trigger, status, timing,
Agent parent/child relationships, role, model, reasoning effort, requested and
effective service tier, Codex thread ID, usage provenance, checkpoints, failures,
recovery decisions, artifact paths, and the durable Evidence References that gate
`completed`.
The Web viewer listens only on `127.0.0.1`, is read-only, and polls the same Trace
projection used by the CLI.

The current Codex SDK does not reliably expose the service tier actually applied
by the upstream gateway, and this implementation has no authoritative
quota-equivalent accounting feed. Trace therefore shows effective Fast state and
equivalent credits as `unknown` unless an `AgentRunner` adapter supplies measured
data. Requested service tier is shown separately and is never treated as proof of
the effective tier.

## Development

```bash
npm install
npm run check
npm start
```

The flake default package installs the trace command and the internal stdio server:

```bash
nix build
./result/bin/agent-workflow trace latest
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
When `CODEX_HOME/app-server-control/app-server-control.sock` exists and Codex adds
`_meta.threadId` to the tool request, title updates use the app-server's
`thread/name/set` RPC. A missing socket or failed title update is reported as a
warning and never changes the Workflow outcome.

Mutable task artifacts live under `tasks/<workflow-id>/`. Their version history
lives separately under `checkpoints/<workflow-id>.git`; the Controller commits only
`task.md`, `journal.md`, and `result.md` at semantic workflow boundaries. Workspace
repositories are never used for Journal history. A non-Nix installation therefore
requires `git` in `PATH`; the Nix package supplies it internally.
Before an Agent turn, an unfinished `result.md` from an interrupted attempt is
discarded. After the turn, the Controller atomically materializes an attested result
envelope containing the validated structured outcome, durable Evidence References,
and any self-contained report the Agent wrote during that turn. Replaying the same
completion is idempotent; a different structured outcome cannot silently replace a
frozen result.
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
When a Controller process is restarted, it restores every active Agent's Task and
Journal from the newest complete Checkpoint recorded in SQLite before constructing
the recovery prompt. A missing or unreadable complete Checkpoint is a terminal
failure with an explicit recovery scope; the Controller does not recreate an empty
Journal and pretend that recovery succeeded.

Each Controller execution generation has a monotonic lease epoch. Checkpoint
commits and lifecycle hook metadata carry that epoch, and child Codex processes
carry the matching immutable lease identity. A stale generation cannot register
authoritative events, checkpoints, or a Terminal Outcome after a takeover.
If a heartbeat runs after its nominal expiry but no takeover has changed the
owner or epoch, the same generation may renew its lease; once another Controller
increments the epoch, the old generation remains fenced permanently.
The separate Git repository may retain an orphan commit created in the narrow window
before a stale generation loses the SQLite write race. Such a commit is explicitly
non-authoritative: recovery and Trace consume only Checkpoints recorded under the
current Workflow state, and epoch-qualified lookup cannot promote it.

`npm run check` uses fake `AgentRunner` implementations for workflow execution and real stdio
subprocesses for the MCP `2025-06-18` and `2026-07-28` handshakes. It does not
spend model quota. `spec/reference-implementation-coverage.json` maps all 33
normative draft clauses to deterministic tests, an implementation-defined choice,
or an explicit partial/external/not-implemented limit. This prevents a green unit
suite from being presented as full Specification conformance; the repository still
describes this program as a candidate reference implementation.

## Current implementation limits

The TypeScript Codex SDK exposes the Codex thread ID but not the App Server turn ID.
The Controller therefore persists thread IDs, its own run IDs, an ordered event
sequence, and the Git commit ID for every semantic Journal checkpoint. It resumes the
thread and asks the Agent to reconcile the current workspace, so interrupted commands
or edits may already have taken effect and must not be replayed blindly. Detailed
Worker and Verifier evidence stays in workspace and task artifacts; the final
Orchestrator prompt receives compact structured outcomes and artifact paths instead
of Agent conversation history.

The Workflow Trace promotes only evidence references present in structured
Verification outcomes. Free-form evidence mentioned only inside a Journal remains
available as an Artifact for on-demand inspection; it is not turned into an
authoritative Trace claim by heuristic text parsing.

The SDK `0.147.0` TypeScript `ThreadOptions` union does not yet include the real
`max` effort. This project passes reasoning effort through the generic Codex config
surface: `luna_xhigh` remains `xhigh`, while `luna_max` and `sol_max` remain `max`.
It never downgrades `max` to `xhigh`.

The repository also contains a Codex plugin manifest and the Interaction skill at
`skills/use-agent-workflow/`. Its stable runtime persona is kept separately at
`skills/use-agent-workflow/references/interaction-persona.md`; unreviewed calibration
cases are not part of the runtime package. Daily wrapper and Home Manager wiring
remain outside this repository.
