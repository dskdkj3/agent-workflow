# Agent Onboarding

This repository implements the standalone Workflow MCP described by the project README.

## Current MVP

- MCP protocol target: modern `2026-07-28`; the stdio entry must also serve the `2025-06-18` initialize handshake used by current Codex clients.
- Public surface: one synchronous tool, `workflow.run`.
- Execution routes: the default path is one `sol_high` Orchestrator, one routed Generic Worker, a fresh-context independent Verifier, then the same Orchestrator finalizes; the explicit bounded fast path is one `luna_max` Worker plus one fresh `luna_max` Verifier, with Controller finalization.
- Allowlisted model profiles are `luna_max`, `terra_high`, `sol_high`, and `sol_max`; preserve the real `max` effort through Codex config and never map it to `xhigh`.
- Codex is behind an `AgentRunner` adapter. Do not couple Controller state or MCP schemas directly to Codex SDK internals.
- Keep provider wiring outside the core; host integrations may inject generic Codex config through `AGENT_WORKFLOW_CODEX_CONFIG_JSON`.
- Orchestrator, Worker, and Verifier must not use or generate Codex Memories and must not create subagents.
- The Verifier must start in a fresh thread, receive the original request plus artifact paths, and avoid the Worker journal unless resolving a specific contradiction.
- Every Agent owns `task.md`, `journal.md`, and `result.md`; `task.md` and completed `result.md` are frozen. On the bounded fast path, the Controller may materialize the Agent's structured outcome into the final Journal and result instead of spending model turns on bookkeeping-only writes.
- SQLite stores lifecycle state, route, events, and checkpoint commit IDs. Markdown artifacts store task narrative and handoff content; a separate local Git repository per workflow preserves semantic versions without touching the Workspace repository.
- Callers SHOULD create and retain `workflow_id` before the first invocation. An identical retry with the same ID resumes a running Workflow or returns its existing Terminal Outcome; changed immutable input under the same ID is invalid.
- Every Agent uses a persistent isolated `CODEX_HOME`. Persist `thread.started` immediately, resume that thread after Controller interruption, checkpoint Task and Journal on `PreCompact`, and reload complete Task and Journal on compact `SessionStart`. Do not duplicate the AGENTS instruction chain in compact hook context.
- Keep detailed evidence outside model handoffs by default: pass compact structured summaries and paths, then load evidence on demand.

## Scope Boundaries

- Do not copy the existing `agent-codex` wrapper implementation into this repository.
- Do not add NixOS, Home Manager, systemd, desktop, worktree-delivery, or PATH installation wiring during the MCP MVP.
- Do not implement MCP Tasks or MRTR until the synchronous vertical slice is validated.
- Keep user interaction outside backend Agents: `needs_input` travels Worker/Verifier -> Orchestrator -> Interaction Agent.
- `skills/use-agent-workflow/` is a repo-local, non-installed Interaction policy. Keep it concise and do not copy the historical conversation export into runtime context.

## Validation

Run:

```bash
npm run check
```

Tests must use a fake `AgentRunner` unless a task explicitly calls for a quota-consuming live Codex probe.
