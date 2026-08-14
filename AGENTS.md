# Agent Onboarding

This repository implements the standalone Workflow MCP described by the project README.

## Current MVP

- MCP protocol target: modern `2026-07-28`; the stdio entry must also serve the `2025-06-18` initialize handshake used by current Codex clients.
- Public MCP surface: synchronous `workflow.run` plus the idempotent `workflow.recovery_decision` recorder. The recovery tool records explicit user approval or denial after `cyber_policy`; it never retries or changes the failed Workflow.
- Execution routes: the default path is one `sol_high` Orchestrator, one routed Generic Worker, a fresh-context independent Verifier, then the same Orchestrator finalizes; the explicit bounded fast path is one `luna_high` Worker plus one fresh `luna_high` Verifier, with Controller finalization.
- Allowlisted model profiles are `luna_high`, `luna_xhigh`, `luna_max`, `terra_high`, `sol_high`, and `sol_max`; preserve the real `xhigh` and `max` efforts through Codex config and never map `max` to `xhigh`.
- The Orchestrator classifies residual Worker and Verifier task shape; the Controller deterministically maps that class to a profile. Route selection must record residual burden, why a lower-cost route is insufficient, and an upgrade trigger. Topic labels such as security, architecture, audit, research, privacy, or cross-source are not sufficient Sol justification.
- Codex is behind an `AgentRunner` adapter. Do not couple Controller state or MCP schemas directly to Codex SDK internals.
- Keep provider wiring outside the core; host integrations may inject generic Codex config through `AGENT_WORKFLOW_CODEX_CONFIG_JSON`.
- Orchestrator, Worker, and Verifier must not use Codex Apps or plugins, use or generate Codex Memories, or create subagents.
- The Verifier must start in a fresh thread, receive the original request plus artifact paths, and avoid the Worker journal unless resolving a specific contradiction.
- Every Agent owns `task.md`, `journal.md`, and `result.md`; `task.md` and completed `result.md` are frozen. Before a turn, discard any unfinished result left by an interrupted attempt. After a turn, preserve any Agent-authored report inside a Controller-attested result envelope; never replace it with only the short structured summary. On the bounded fast path, the Controller may materialize the Agent's structured outcome into the final Journal and result instead of spending model turns on bookkeeping-only writes.
- SQLite stores lifecycle state, route, events, and checkpoint commit IDs. Markdown artifacts store task narrative and handoff content; a separate local Git repository per workflow preserves semantic versions without touching the Workspace repository.
- Controller mutations require the current lease owner and monotonic epoch. A superseded Controller, Agent turn, or lifecycle hook must not write authoritative events, checkpoints, artifacts, or a Terminal Outcome.
- Callers SHOULD create and retain `workflow_id` before the first invocation. An identical retry with the same ID resumes a running Workflow or returns its existing Terminal Outcome; changed immutable input under the same ID is invalid.
- Every Agent uses a persistent isolated `CODEX_HOME`. Persist `thread.started` immediately, resume that thread after Controller interruption, checkpoint Task and Journal on `PreCompact`, and reload complete Task and Journal on compact `SessionStart`. Do not duplicate the AGENTS instruction chain in compact hook context.
- Before resuming an interrupted Agent, restore its Task and Journal from the newest authoritative complete Checkpoint recorded by SQLite. Missing or unreadable recovery artifacts are a failure, not permission to recreate an empty Journal.
- A Verifier may return `passed` only with at least one durable Evidence Reference to an existing regular file inside the Workspace or Workflow task directory. Evidence absence or invalid scope must prevent `completed` on every route.
- Recheck caller cancellation after every Runner return and before persisting completion or dispatching the next Agent; a Runner that ignores `AbortSignal` cannot advance the Workflow.
- A `cyber_policy` classification is a hard stop. Preserve the failure and artifacts, set `recovery_requires_user_approval`, expose no automatic retry route, and wait for an explicit Recovery Decision before any semantically different attempt.
- `Workflow Trace` is the only authoritative read projection. CLI text, JSON, follow mode, and the loopback-only Web viewer must consume it instead of independently parsing storage. Missing actual Fast state or quota-equivalent usage must remain `unknown`.
- Unknown usage has no numeric value in terminal output or Trace; do not expose internal zero placeholders as observed consumption. Keep `spec/reference-implementation-coverage.json` synchronized with all 33 normative draft clauses and their tests or explicit limits.
- Keep detailed evidence outside model handoffs by default: pass compact structured summaries and paths, then load evidence on demand.
- The installed read surface is `agent-workflow trace ...`; the internal MCP server remains `agent-workflow-mcp`.
- The Interaction policy has three states: conversation, deliberation, and execution-ready. Read-only research may inform deliberation, but workspace mutation and `workflow.run` require an actual execution commitment; user corrections or additional design requirements are not commitment by themselves. Deliberation must start from the user's existing system and the event that is actually actionable, not a vendor-default greenfield assumption.

## Scope Boundaries

- Do not copy the existing `agent-codex` wrapper implementation into this repository.
- Do not add NixOS, Home Manager, systemd, desktop, worktree-delivery, or PATH installation wiring during the MCP MVP.
- Do not implement MCP Tasks or MRTR until the synchronous vertical slice is validated.
- Keep user interaction outside backend Agents: `needs_input` travels Worker/Verifier -> Orchestrator -> Interaction Agent.
- `skills/use-agent-workflow/` is a repo-local, non-installed Interaction policy. Keep it concise and do not copy the historical conversation export into runtime context.
- The stable Interaction persona is `skills/use-agent-workflow/references/interaction-persona.md`. Runtime integrations may load it alongside the policy, but must not ship or inject unreviewed calibration cases.

## Validation

Run:

```bash
npm run check
```

Tests must use a fake `AgentRunner` unless a task explicitly calls for a quota-consuming live Codex probe.
