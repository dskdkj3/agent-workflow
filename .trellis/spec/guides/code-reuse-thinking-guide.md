# Code reuse and ownership guide

Before adding a helper, locate the existing owner of the behavior:

- Input and output validation belongs in the Zod schemas in `src/contracts.ts`.
- Workflow transitions and lease-checked writes belong in `src/controller.ts`
  and `src/state.ts`.
- Artifact creation, freezing, regular-file checks, and Controller signatures
  belong in `src/journal.ts`.
- Checkpoint path and commit validation belongs in `src/checkpoints.ts`.
- Read-only aggregation belongs in `src/trace.ts`; formatters and the Web
  viewer consume that result.
- Codex SDK/provider handling belongs in `src/agent-runner.ts` and
  `src/codex-home.ts`, behind `AgentRunner`.

Prefer extending an existing owner over introducing a second state machine,
database reader, evidence validator, or SDK wrapper. If a new abstraction is
needed, document why the current owner cannot express it and add a focused
test for the boundary.

Avoid copying logic from `src/controller.ts` into `src/trace.ts` or from
`src/trace.ts` into `src/cli.ts`/`src/trace-web.ts`. The Trace projection is the
single read-model seam.

References: `AGENTS.md`, `src/controller.ts`, `src/state.ts`, `src/journal.ts`,
`src/checkpoints.ts`, `src/trace.ts`, and `src/agent-runner.ts`.
