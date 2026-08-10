# Agent Onboarding

This repository implements the standalone Workflow MCP described by the project README.

## Current MVP

- MCP protocol target: `2026-07-28`; the stdio entry rejects legacy connections.
- Public surface: one synchronous tool, `workflow.run`.
- Execution path: one Orchestrator thread, one Generic Worker thread, then the same Orchestrator thread verifies and finalizes.
- Codex is behind an `AgentRunner` adapter. Do not couple Controller state or MCP schemas directly to Codex SDK internals.
- Orchestrator and Worker must not use or generate Codex Memories and must not create subagents.
- Every Agent owns `task.md`, `journal.md`, and `result.md`; `task.md` and completed `result.md` are frozen.
- SQLite stores lifecycle state and events. Markdown artifacts store task narrative and handoff content.

## Scope Boundaries

- Do not copy the existing `agent-codex` wrapper implementation into this repository.
- Do not add NixOS, Home Manager, systemd, desktop, worktree-delivery, or PATH installation wiring during the MCP MVP.
- Do not implement MCP Tasks or MRTR until the synchronous vertical slice is validated.
- Keep user interaction outside backend Agents: `needs_input` travels Worker -> Orchestrator -> Interaction Agent.

## Validation

Run:

```bash
npm run check
```

Tests must use a fake `AgentRunner` unless a task explicitly calls for a quota-consuming live Codex probe.
