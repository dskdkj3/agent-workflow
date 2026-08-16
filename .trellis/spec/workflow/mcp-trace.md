# MCP protocol and Workflow Trace

The public boundary is a synchronous stdio MCP server. The installed read
surface is the `agent-workflow trace` CLI; the internal server process is
`agent-workflow-mcp`. All public views must consume the same `WorkflowTrace`
projection.

## Protocol boundary

- Keep the public tools limited to `workflow.run` and the idempotent
  `workflow.recovery_decision` recorder until a separate task approves a
  protocol expansion.
- `workflow.run` assigns or preserves a UUID, validates input with
  `workflowRunInputSchema`, passes the caller abort signal through the
  Controller, and returns `workflowRunOutputSchema` structured content plus a
  compact text summary and artifact directory.
- The stdio entry must serve MCP `2026-07-28` and the `2025-06-18` initialize
  handshake used by current Codex clients. Keep the SDK legacy compatibility
  option in `src/server.ts` covered by protocol tests.
- Recovery decisions record explicit user approval/denial after a
  `cyber_policy` failure. They never retry or mutate the failed Workflow.
- Do not expose raw SQLite rows, Journal text, or internal prompt transcripts
  as a substitute for the public result.

## Trace projection

`buildWorkflowTrace` and `loadWorkflowTrace` in `src/trace.ts` are the only
authoritative read model. It must include route rationale, status/timing,
Agent parent-child relationships, model/reasoning effort, requested versus
effective service tier, usage provenance, checkpoints, failures, recovery
decisions, artifacts, and durable Evidence References.

Unknown values stay unknown: an unavailable actual Fast state or quota
equivalent is `null` with `status=unknown`, never numeric zero or a request
value presented as observed consumption. Evidence paths are validated before
they are promoted into Trace.

The text formatter, JSON CLI, follow mode, and loopback-only Web viewer all
consume this projection. The Web viewer must keep the loopback Host check,
security headers, regular-file/no-follow artifact reads, and no-store behavior.

## References and tests

- `src/server.ts` — MCP server name/version, tool schemas, annotations,
  structured output, abort propagation, and legacy stdio serve mode.
- `src/contracts.ts` — Zod input/output, route/profile, usage, failure, and
  Evidence Reference contracts.
- `src/trace.ts` — authoritative read model and artifact/evidence validation.
- `src/trace-format.ts`, `src/cli.ts`, and `src/trace-web.ts` — all Trace
  presentation paths.
- `src/server.test.ts` — initialize compatibility, tool output, cancellation,
  and title-reporting isolation.
- `src/trace.test.ts` — projection provenance, shared CLI views, unknown usage,
  legacy read-only loading, loopback security, and symlink rejection.
- `README.md` and `spec/DRAFT.zh-CN.md` — public protocol and draft semantics.

## Avoid

- Do not add a second parser for SQLite or Markdown to the CLI/Web layer.
- Do not infer completion from a free-form Journal or Worker summary.
- Do not widen the Web viewer beyond loopback or turn artifact links into
  arbitrary filesystem reads.
