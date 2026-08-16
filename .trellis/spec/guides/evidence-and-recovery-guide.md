# Evidence and recovery guide

Every side-effectful change must preserve both proof and resumability.

- Save the Task Request before mutation, and keep `task.md` immutable.
- Record meaningful decisions and evidence in the Journal, but never treat
  Journal text as authoritative completion state.
- Checkpoint Task and Journal at semantic boundaries through
  `CheckpointRepository`; associate the checkpoint with the active lease
  epoch in `StateStore`.
- On interruption, restore the newest complete authoritative checkpoint and
  discard unfinished results. Missing artifacts are failures to recover, not
  permission to guess.
- For a `completed` claim, require a Verifier Evidence Reference to an existing
  regular file within the Workspace or Workflow task directory. Validate
  containment and symlink status again at the Controller/Trace boundary.
- Represent unavailable usage, Fast state, or quota-equivalent as `unknown`;
  never manufacture zero-valued evidence.

When tests need a proof artifact, place it in a temporary Workspace or task
directory and assert its path is accepted/rejected by the same code path used
in production. Use `src/controller.test.ts`, `src/checkpoints.test.ts`,
`src/lifecycle-hook.test.ts`, and `src/trace.test.ts` as models.
