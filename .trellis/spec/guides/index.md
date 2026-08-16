# Cross-cutting thinking guides

These guides apply whenever a change crosses the Interaction, Controller,
AgentRunner, MCP, or release boundaries. They are repository-specific prompts
for reasoning, not generated application-layer instructions.

## Pre-Development Checklist

- Read `AGENTS.md` and `README.md`.
- Read the relevant `../workflow/` topic spec(s).
- Identify the system of record: Interaction skill, MCP schemas, SQLite state,
  Markdown artifacts, checkpoint Git, or Workflow Trace.
- Name the invariant and the test that will prove it before changing code.
- Keep provider/runtime integration at the adapter boundary and keep public
  read paths on the Trace projection.

## Guides

- `code-reuse-thinking-guide.md` — reuse existing lifecycle, validation, and
  projection helpers before adding parallel code paths.
- `cross-layer-thinking-guide.md` — trace a change across policy, Controller,
  adapter, protocol, and presentation layers.
- `evidence-and-recovery-guide.md` — preserve durable evidence and recovery
  semantics while changing execution or persistence.

## Quality Check

Run `npm run check` and `git diff --check`, then confirm that every changed
public or persisted behavior has matching evidence in the topic spec and a
deterministic test.
