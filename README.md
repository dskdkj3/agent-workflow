# Agent Workflow

Agent Workflow is a standalone Workflow MCP for running bounded, model-backed
work with durable task artifacts, independent verification, resumable
checkpoints, and one authoritative trace. It is intended to make the lifecycle
around a Codex-based execution explicit: what was requested, which route ran,
what evidence supports the result, and what remains unknown.

This repository is an **MVP / candidate reference implementation**, not a
production-ready service, a stable public API, or a declaration of full
Workflow Specification conformance. The accompanying specification is still a
discussion draft. The implementation is useful for evaluating the synchronous
vertical slice and its lifecycle guarantees while those interfaces and tests
continue to evolve.

## Quick start

Requirements:

- Node.js 24 or newer
- npm
- Git

From a fresh checkout:

```sh
git clone https://github.com/dskdkj3/agent-workflow.git
cd agent-workflow
npm ci
npm run check
```

The check builds the TypeScript sources and runs the deterministic test suite.
The tests use fake `AgentRunner` implementations for workflow execution; they
do not spend live model quota. To start the stdio MCP server after the check:

```sh
npm start
```

`npm start` waits for an MCP client on stdin/stdout. The installed read-only
trace command is available after the build:

```sh
agent-workflow trace latest
```

One synchronous `workflow.run` request can contain the complete coding task.
Callers SHOULD create and retain the UUID before the first invocation so that
an identical retry can resume the same Workflow Run or return its existing
Terminal Outcome:

```json
{
  "workflow_id": "de305d54-75b4-431b-adb2-eb6b9e546014",
  "request": "Run the focused tests and report whether the requested behavior is observable.",
  "workspace": "/absolute/path/to/workspace"
}
```

Omitting `execution_route` selects the default `orchestrated` route, and
omitting `completion_criteria` supplies an empty list for that route. The
explicit `single_worker` fast path requires at least one observable criterion:

```json
{
  "workflow_id": "de305d54-75b4-431b-adb2-eb6b9e546014",
  "request": "Add the missing focused test and run it.",
  "workspace": "/absolute/path/to/workspace",
  "execution_route": "single_worker",
  "completion_criteria": ["The focused test passes"]
}
```

The MCP result is structured and includes the terminal status, Workflow ID,
task directory, result path, usage provenance, route, and any questions or
blocker. A synchronous call may run a full coding task, so clients must use a
longer tool timeout than a normal short tool; for example,
`tool_timeout_sec = 3600`.

## Architecture at a glance

```text
Interaction Agent
  -> workflow.run
       -> default: Orchestrator -> routed Worker
       -> fast:    bounded Worker
       -> fresh-context independent Verifier
       -> Orchestrator judgment, or Controller finalization on fast path
  -> Terminal Outcome and artifact paths

cyber_policy failure
  -> workflow.recovery_decision records explicit approval or denial
  -> an approved semantically different attempt starts as a new Workflow Run
```

The Interaction policy keeps user discussion outside backend Agents. A
`needs_input` result travels back to the Interaction Agent, which discusses the
questions with the user and starts a new call with clarified input. Backend
Agents do not coordinate the user, other Agents, Codex Apps, plugins, Memories,
or nested subagents.

## Public MCP surface

The current implementation uses MCP SDK `2.0.0`, targets protocol revision
`2026-07-28`, and also serves the `2025-06-18` initialize handshake used by
current Codex clients. Transport is stdio only; the public tools are
`workflow.run` and `workflow.recovery_decision`.

### `workflow.run`

`workflow.run` is the synchronous execution tool. Its input is:

| Field | Meaning |
| --- | --- |
| `workflow_id` | Optional UUID; callers SHOULD supply and retain it for idempotent retries. |
| `request` | Required normalized task request text. |
| `workspace` | Optional absolute workspace path; the Controller resolves the configured default when omitted. |
| `execution_route` | `orchestrated` (default) or the explicitly bounded `single_worker` fast path. |
| `completion_criteria` | Observable criteria; required for `single_worker`, optional for the default route. |

An identical retry with the same Workflow ID and immutable input resumes a
running Workflow or returns its existing Terminal Outcome without another model
call after termination. Reusing a Workflow ID with changed immutable input is
invalid. A SQLite lease prevents two Controllers from advancing the same run.

The terminal status is one of `completed`, `needs_input`, `blocked`, `failed`,
or `cancelled`. `completed` is gated by independent Verification and durable
Evidence References; internal errors, timeouts, missing checkpoints, unfinished
verification, and insufficient evidence cannot be represented as completed.

### `workflow.recovery_decision`

This is an idempotent recorder for an explicit user decision after a
`cyber_policy` failure:

```json
{
  "workflow_id": "de305d54-75b4-431b-adb2-eb6b9e546014",
  "decision_id": "3f2d4e6a-7f3a-4d2b-9c01-1e9e5c2f0b11",
  "decision": "approved",
  "note": "Proceed with the semantically different recovery described to me."
}
```

It records approval or denial on the failed Workflow and **never retries or
changes that failed Workflow**. Approval is authority to attempt a materially
different recovery; it is not itself a retry or a successful result. The new
attempt receives a new Workflow ID. There is no automatic retry route for a
`cyber_policy` failure.

## Execution routes and model mapping

The implementation keeps model family and reasoning effort as separate,
auditable choices. The Orchestrator classifies the residual Worker and
Verifier task shape; the Controller maps that class to an allowlisted profile.
Each new routed plan records the residual burden, why a lower-cost route is
insufficient, and the condition that would require escalation. A topic label
such as security, architecture, audit, research, privacy, or cross-source is
not by itself a justification for a Sol route.

The default route uses one `sol_high` Orchestrator, one routed Generic Worker,
a fresh-context independent Verifier, and the same Orchestrator to finalize:

```text
Orchestrator (sol_high)
  -> Generic Worker (Controller-selected profile)
  -> independent Verifier (Controller-selected profile, fresh thread)
  -> Orchestrator final judgment
```

The explicit bounded fast path uses one `luna_high` Worker and one fresh
`luna_high` Verifier, followed by Controller finalization. If the Worker asks
for escalation or the Verifier rejects the result, the outcome can expose
`retry_route: "orchestrated"` for the Interaction Agent to start a new attempt.

### Worker profiles

| Residual Worker task class | Profile | Model and effort |
| --- | --- | --- |
| `short_bounded` | `luna_high` | `gpt-5.6-luna`, `high` |
| `bounded_execution` | `luna_xhigh` | `gpt-5.6-luna`, `xhigh` |
| `long_horizon_execution` | `luna_max` | `gpt-5.6-luna`, `max` |
| `bounded_judgment` | `terra_high` | `gpt-5.6-terra`, `high` |
| `irreducible_synthesis` | `sol_high` | `gpt-5.6-sol`, `high` |
| `critical_deliberation` | `sol_max` | `gpt-5.6-sol`, `max` |

### Verifier profiles

| Residual Verifier task class | Profile |
| --- | --- |
| `mechanical_check` | `luna_high` |
| `bounded_evidence_review` | `terra_high` |
| `irreducible_review` | `sol_high` |
| `critical_review` | `sol_max` |

The allowlist is `luna_high`, `luna_xhigh`, `luna_max`, `terra_high`,
`sol_high`, and `sol_max`. The real `xhigh` and `max` efforts are preserved
through the generic Codex configuration surface; `max` is never silently
downgraded to `xhigh`. The bounded-execution choices were calibrated against
the current [DeepSWE v1.1 curve](https://deepswe.datacurve.ai/blog/deepswe-v1-1),
not copied from its leaderboard. That benchmark is not evidence about
user-intent interpretation, open-ended research, architecture discussion, or
safety review; those roles require local workflow evaluations.

## Lifecycle, artifacts, and recovery

Before a Workspace mutation or side-effectful execution, the Controller saves a
Task Request containing the objective, material constraints, completion meaning,
and allowed working scope. Every Agent owns a `task.md`, `journal.md`, and
`result.md` under the Workflow task directory:

- `task.md` is the frozen task narrative for that Agent.
- `journal.md` records decisions, work performed, uncertainty, evidence, and
  next steps.
- A completed `result.md` is frozen. An unfinished result left by an interrupted
  attempt is discarded before resumption.
- After a turn, any Agent-authored report is preserved inside a
  Controller-attested result envelope instead of being replaced by only a
  short structured summary.

SQLite stores lifecycle state, route, events, and authoritative checkpoint
commit IDs. Markdown artifacts store task narrative and handoff content. A
separate local Git repository under `checkpoints/<workflow-id>.git` preserves
semantic versions without touching the Workspace repository. The Controller
commits `task.md`, `journal.md`, and `result.md` at semantic workflow boundaries.

Every Agent uses a persistent isolated `CODEX_HOME`. The Controller records a
Codex `thread.started` event immediately, resumes that thread after a process
interruption, checkpoints Task and Journal on `PreCompact`, and reloads the
complete Task and Journal on compact `SessionStart`. On process recovery, the
new Controller restores active artifacts from the newest authoritative complete
Checkpoint recorded by SQLite. Missing or unreadable recovery artifacts are a
failure; the Controller does not recreate an empty Journal and pretend that
recovery succeeded.

Each Controller generation has a monotonic lease epoch. Only the current lease
owner and epoch may write authoritative events, checkpoints, artifacts, or a
Terminal Outcome. A stale Controller, Agent turn, or lifecycle hook may leave a
non-authoritative local Git commit in a narrow race, but it cannot advance the
Workflow. Caller cancellation is rechecked after every Runner return and before
persisting completion or dispatching the next Agent, including when a Runner
ignores or races its `AbortSignal`.

## Verification and safety stops

The Verifier starts in a fresh thread, receives the original request plus
artifact paths, and does not read the Worker Journal unless it is resolving a
specific contradiction. A Verifier may return `passed` only when it includes at
least one Evidence Reference to an existing regular file inside the Workspace
or Workflow task directory. Missing, unreadable, non-regular, or out-of-scope
evidence prevents `completed` on every route. The Trace promotes only these
structured evidence references; free-form evidence mentioned only in a Journal
remains an Artifact for on-demand inspection and is not treated as an
authoritative Trace claim.

A `cyber_policy` classification is a hard stop. The implementation preserves
the failure and artifacts, sets `recovery_requires_user_approval`, exposes no
automatic retry route, and waits for an explicit Recovery Decision. It does not
silently rewrite, split, switch, or retry the request. Other route or
verification failures may return a non-completed outcome or expose the
bounded `orchestrated` retry suggestion described above.

## Workflow Trace and resource semantics

`Workflow Trace` is the only authoritative read projection. CLI text, JSON,
follow mode, and the loopback-only Web viewer all consume it rather than
independently parsing SQLite or Markdown:

```sh
agent-workflow trace latest
agent-workflow trace <workflow-id>
agent-workflow trace --follow <workflow-id>
agent-workflow trace --json <workflow-id>
agent-workflow trace --web <workflow-id>
```

The Trace includes route and route-class rationale, the upgrade trigger, status,
timing, Agent parent/child relationships, role, model, reasoning effort,
requested and effective service tier, Codex thread ID, usage provenance,
checkpoints, failures, recovery decisions, artifact paths, and durable Evidence
References.

The current Codex SDK does not reliably expose the service tier actually applied
by the upstream gateway, and this implementation has no authoritative
quota-equivalent accounting feed. Effective Fast state and equivalent credits
therefore remain `unknown` unless an `AgentRunner` adapter supplies measured
data. Requested service tier is shown separately and is never treated as proof
of the effective tier. Usage is reported as `measured`, `estimated`, `partial`,
or `unknown`; when it is unknown, the public `usage` value is `null`, not a
numeric zero placeholder. A resumed thread's latest cumulative SDK snapshot
replaces its earlier snapshot, so repeated rounds can increase `input_tokens`
even when context is cached; this is cumulative model processing, not unique
context size.

When a caller exposes the same Codex app-server Unix socket and supplies its
thread ID in MCP request metadata, the server best-effort names that thread
`Workflow <workflow-id> · <status>` for statusline display. A missing socket or
failed title update is a warning and never changes the Workflow outcome.

## Installation and configuration

The repository provides a standalone Nix package for the internal
`agent-workflow-mcp` server and the `agent-workflow` trace command:

```sh
nix build
./result/bin/agent-workflow trace latest
./result/bin/agent-workflow-mcp
```

The installed read surface is `agent-workflow trace ...`; the internal MCP
server remains `agent-workflow-mcp`. State defaults to
`${XDG_STATE_HOME:-~/.local/state}/agent-workflow` and can be overridden with
`AGENT_WORKFLOW_STATE_DIR`. Use `AGENT_WORKFLOW_CODEX_PATH` to validate a
specific SDK-managed Codex executable.

If the server is registered in child Codex configuration, set
`AGENT_WORKFLOW_MCP_SERVER_NAME` to that registration name so backend Agents
cannot recursively invoke this Workflow MCP. Host integrations may pass
generic provider-specific Codex settings through
`AGENT_WORKFLOW_CODEX_CONFIG_JSON`; keep secrets out of that JSON and refer to
an inherited environment variable with the provider's `env_key` instead.

Provider wiring stays outside the core. The backend does not use Codex Apps or
plugins, generate or consume Codex Memories, or create subagents. Daily wrapper
and Home Manager wiring, desktop integration, PATH installation, systemd, and
worktree delivery remain outside this repository.

## Scope and known limits

- Transport is stdio only. MCP Tasks, MRTR, a scheduler, a general retry
  engine, and a persistent routing learner are not implemented.
- The default route still carries most constraints and completion meaning in
  free-text `request`; a complete stable Task Request field model is not yet
  exposed. The explicit fast path has a separate `completion_criteria` field.
- Verification is synchronous in the current vertical slice. The specification
  permits asynchronous Verification, but this implementation does not expose
  that capability.
- `spec/reference-implementation-coverage.json` maps all 33 normative draft
  clauses to deterministic tests, implementation-defined choices, or explicit
  partial/external/not-implemented limits. It is an implementation coverage
  map, not a conformance suite or a full-conformance claim.
- The TypeScript Codex SDK `0.147.0` does not yet include the real `max` effort
  in its `ThreadOptions` union. The implementation preserves it through the
  generic Codex config surface as described above.
- A current SDK limitation exposes the Codex thread ID but not the App Server
  turn ID. The Controller therefore persists its own run IDs, ordered events,
  thread IDs, and checkpoint commit IDs and asks a resumed Agent to reconcile
  the Workspace; interrupted edits or commands may already have taken effect
  and must not be replayed blindly.
- `skills/use-agent-workflow/` is a concise, repo-local, non-installed
  Interaction policy. Its stable runtime persona is kept at
  `skills/use-agent-workflow/references/interaction-persona.md`; unreviewed
  calibration cases are not shipped or injected into runtime context.

The supported specification language and current gaps are documented in
[`CONTEXT.md`](./CONTEXT.md), [`spec/DRAFT.zh-CN.md`](./spec/DRAFT.zh-CN.md),
and [`spec/CONFORMANCE-SCENARIOS.zh-CN.md`](./spec/CONFORMANCE-SCENARIOS.zh-CN.md).

## License

Agent Workflow is available under the [Apache License 2.0](./LICENSE).
`package.json` uses the SPDX identifier `Apache-2.0` and remains marked
`private: true`; that metadata does not claim that this repository is published
or intended for npm distribution.
