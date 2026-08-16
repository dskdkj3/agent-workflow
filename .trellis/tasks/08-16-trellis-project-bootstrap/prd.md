# Bootstrap Trellis project layer

## Dependency and delivery

This child task depends on the outer `nixos-config` task
`.trellis/tasks/08-16-trellis-long-term-adoption`. It owns only the
`agent-workflow` repository layer and is delivered to `origin/main`; the outer
task consumes the resulting revision during the registered-repository rollout.

## Goal

Make `agent-workflow` a clean, repository-native Trellis project without
changing the TypeScript MCP behavior. The project layer must explain the real
Interaction, Controller, AgentRunner, MCP/Trace, testing/evidence, and
release/compatibility boundaries to future implementers and reviewers.

## Requirements

- Run pinned Trellis `0.6.15` onboarding with
  `trellis init --codex --yes --skip-existing --user xsy`; never overwrite the
  existing root `AGENTS.md` and never use `--force`.
- Keep the project task under `.trellis/tasks/08-16-trellis-project-bootstrap`
  with the `08-16` prefix, `createdAt=2026-08-16`, dependency and
  `origin/main` metadata, and status `in_progress` after `task.py start`.
- Replace generated backend/frontend template specs with concrete
  repository-native specs and preserve/expand the shared thinking guides.
- Preserve the existing root `AGENTS.md` byte-for-byte; project navigation and
  validation live in the Trellis spec indexes and task artifacts, not in a
  second root policy file.
- Configure all three Codex Trellis roles to start at
  `gpt-5.6-luna`/`max` in a fresh context; preserve an explicit caller path to
  upgrade implement/check/research to a Sol profile after a material failure or
  irreducible judgment. Project config must declare the default subagent
  policy and fresh-context requirement.
- Add `AGENT_CODEX_TRELLIS_USER_DISPATCH=1` guards to generated project hook
  entry scripts. The guard must exit successfully with no stdout; ordinary
  non-wrapper Codex invocations must retain project hook behavior.

## Acceptance Criteria

- [ ] `trellis --version` reports `0.6.15`, onboarding succeeds with
      `--skip-existing`, and the pre-existing `AGENTS.md` is byte-for-byte
      unchanged.
- [ ] The task directory has `08-16` prefix, `createdAt` is `2026-08-16`,
      dependency points to the outer task, delivery/base branch is
      `origin/main`, and `status` is `in_progress`.
- [ ] `.trellis/spec/` contains only the workflow topics and concrete guides
      listed in its indexes; no generated backend/frontend template files or
      placeholder text remains.
- [ ] Every rule in the six required topic specs cites an existing source,
      test, `AGENTS.md`, `README.md`, or spec path in this repository.
- [ ] Research, implement, and check start at `gpt-5.6-luna` with `max`, each
      states the fresh-context/upgrade rule, and project config records the
      default subagent policy.
- [ ] Each generated project hook entry exits silently when the wrapper marker
      is set and still emits its normal hook output when the marker is absent.
- [ ] `npm run check`, TOML/JSON/YAML parsing, Python compilation, Trellis
      task/context validation, placeholder/template grep, and `git diff --check`
      pass without changing product source behavior.

## Out of scope

- Runtime user-layer dispatch, hook-trust persistence, first-task onboarding,
  task recovery, `trellis mem` integration, registry readiness, and rollout
  docs belong to the outer `nixos-config` task.
- No commit, push, task archive, or live deployment is performed by this
  child task.
