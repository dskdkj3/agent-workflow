# Agent Onboarding

This repository implements the standalone Workflow MCP described by the project README.

## Current MVP

- MCP protocol target: `2026-07-28`; the stdio entry rejects legacy connections.
- Public surface: one synchronous tool, `workflow.run`.
- Execution path: one `sol_high` Orchestrator thread, one routed Generic Worker thread, one fresh-context independent Verifier thread, then the same Orchestrator thread judges and finalizes.
- Allowlisted model profiles are `luna_max`, `terra_high`, `sol_high`, and `sol_max`; preserve the real `max` effort through Codex config and never map it to `xhigh`.
- Codex is behind an `AgentRunner` adapter. Do not couple Controller state or MCP schemas directly to Codex SDK internals.
- Orchestrator, Worker, and Verifier must not use or generate Codex Memories and must not create subagents.
- The Verifier must start in a fresh thread, receive the original request plus artifact paths, and avoid the Worker journal unless resolving a specific contradiction.
- Every Agent owns `task.md`, `journal.md`, and `result.md`; `task.md` and completed `result.md` are frozen.
- SQLite stores lifecycle state and events. Markdown artifacts store task narrative and handoff content.
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
