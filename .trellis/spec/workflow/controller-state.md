# Controller state, leases, journals, and checkpoints

`WorkflowController` owns lifecycle progression. `StateStore` is the SQLite
authority for lifecycle state, events, leases, and checkpoint references;
Markdown artifacts are the task narrative and handoff surface; the private
checkpoint Git repository stores semantic versions without touching the
Workspace repository.

## State-machine rules

- Validate `WorkflowRunInput` with the schemas in `src/contracts.ts` before
  creating state. Persist the Workflow ID, immutable request, workspace,
  route, completion criteria, and task directory before any Workspace
  mutation or Agent turn.
- Use one Controller lease owner and monotonic lease epoch per running
  Workflow. Every authoritative mutation goes through `StateStore` lease
  checks. A stale Controller, Agent turn, or lifecycle hook must fail rather
  than append events, write artifacts, record checkpoints, or produce a second
  terminal outcome.
- Keep retries idempotent: the same Workflow ID and immutable input resumes a
  running Workflow or returns its existing terminal outcome. Changed immutable
  input under the same ID is invalid.
- The default route is Orchestrator planning, one routed Worker, independent
  Verifier, and the same Orchestrator finalization. The explicit fast path is
  one bounded Worker and fresh-context Verifier. Both paths persist the same
  lifecycle artifacts and evidence gates.
- Re-check cancellation after every AgentRunner return and before dispatching
  the next Agent or persisting completion. An Agent that ignores `AbortSignal`
  must not advance the Workflow.

## Artifacts and recovery

Every Agent owns `task.md`, `journal.md`, and `result.md` under the Workflow
task directory. `task.md` and finalized `result.md` are frozen. Before a
resumed turn, remove an unfinished result and restore the newest authoritative
complete checkpoint; missing or unreadable checkpoint artifacts are an
explicit failure, never permission to recreate an empty journal.

`CheckpointRepository` accepts only the expected Agent artifact paths and
rejects unexpected files, frozen-file rewrites, invalid commit IDs, and
checkpoints from the wrong lease epoch. Lifecycle hooks use the persisted lease
identity in `src/lifecycle-hook.ts` for `PreCompact` and compact `SessionStart`.

## References and tests

- `src/controller.ts` — route state machine, lease heartbeat, Agent dispatch,
  verification gate, cancellation, failure classification, and terminal output.
- `src/state.ts` — SQLite schema/migrations, lease fencing, events, Agent run
  records, terminal outcome idempotency, and recovery decisions.
- `src/journal.ts` — regular-file writes, frozen task/result semantics,
  Controller-attested result envelopes, and Evidence Reference rendering.
- `src/checkpoints.ts` — private Git checkpoint repository and path/epoch
  validation.
- `src/lifecycle-hook.ts` — lease-bound `PreCompact` checkpoint and compact
  context reload; it must not duplicate the AGENTS instruction chain.
- `src/controller.test.ts`, `src/state.test.ts`, `src/checkpoints.test.ts`,
  and `src/lifecycle-hook.test.ts` — lease takeover, recovery, frozen files,
  cancellation, terminal uniqueness, and compact behavior.

## Avoid

- Do not write a shared mutable global “current task” pointer for Workflow
  recovery; the Controller database and per-run task directory are the
  authority.
- Do not use the Workspace repository for semantic checkpoint commits.
- Do not mark `completed` from a Worker claim, Journal text, or a missing
  Verification result.
