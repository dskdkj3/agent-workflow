# Tests, Evidence References, and coverage

The test suite is deterministic Node test code compiled by TypeScript. Tests
should exercise public contracts and lifecycle invariants with temporary state
directories and fake `AgentRunner` implementations.

## Test patterns

- Run `npm run check` for the required build-plus-test gate. It invokes `tsc`
  through `npm run build` and then `node --test dist/*.test.js`.
- Use the fixture/fake-runner patterns in `src/controller.test.ts` for route,
  recovery, cancellation, lease, usage, and Evidence Reference cases.
- Use focused unit tests for persistence (`src/state.test.ts`,
  `src/checkpoints.test.ts`, `src/journal.test.ts`), adapter contracts
  (`src/agent-runner.test.ts`), hooks (`src/lifecycle-hook.test.ts`), MCP
  transport (`src/server.test.ts`), and Trace presentation
  (`src/trace.test.ts`).
- Keep Interaction policy regressions in `src/interaction-policy.test.ts`;
  it reads the shipped skill/persona/metadata files so policy drift is visible
  to the normal check.
- When a claim is normative or intentionally incomplete, update
  `spec/reference-implementation-coverage.json` with real evidence paths and
  an honest status (`tested`, `partial`, `implementation_defined`,
  `external`, or `not_implemented`). The map currently covers all 33 draft
  clauses; do not remove a clause to make a check pass.

## Evidence gate

A Verifier may return `passed` only with at least one Evidence Reference to an
existing regular file under the Workspace or Workflow task directory. The
Controller revalidates absolute paths, containment, regular-file status, and
readability in `src/controller.ts` before allowing `completed`. A Journal
mention or a Worker statement is not evidence by itself.

When adding a completion test, assert both the positive evidence path and the
negative cases: missing, relative, out-of-scope, directory, and symlink paths.
The existing cases in `src/controller.test.ts` and `src/trace.test.ts` are the
reference style.

## References and checks

- `package.json` — canonical `build`, `test`, `check`, and `start` commands.
- `src/controller.test.ts` — end-to-end fake-runner lifecycle and completion
  gates.
- `src/checkpoints.test.ts`, `src/journal.test.ts`, `src/state.test.ts` —
  persistence and recovery invariants.
- `src/spec-coverage.test.ts` — ensures every normative draft clause has a
  coverage entry.
- `spec/reference-implementation-coverage.json` — status/evidence index.
- `spec/DRAFT.zh-CN.md` and `spec/CONFORMANCE-SCENARIOS.zh-CN.md` — draft
  clauses and scenario intent; the repository remains a candidate reference
  implementation, not a full conformance claim.

## Avoid

- Do not replace a fake runner with live Codex traffic for convenience.
- Do not mark a test as evidence merely because it produces a zero-valued
  usage object; unknown usage must remain unknown in the Trace.
- Do not assert implementation-private database details when a public Trace or
  MCP result can express the invariant.
