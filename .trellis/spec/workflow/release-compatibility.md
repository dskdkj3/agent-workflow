# Release and compatibility

This repository ships two Node entry points from one Nix package: the
read-only `agent-workflow` Trace CLI and the stdio `agent-workflow-mcp` server.
The package is an MVP/candidate reference implementation, so compatibility
claims must be explicit and backed by tests.

## Versioned surfaces

- Keep Node 24 as the supported runtime. `package.json` owns npm scripts and
  dependency versions; `flake.nix` uses `buildNpmPackage` with `nodejs_24` and
  the pinned `npmDepsHash`.
- Preserve the MCP protocol targets documented in `README.md` and
  `src/server.ts`: modern `2026-07-28` plus the current Codex
  `2025-06-18` initialize handshake.
- Treat `src/contracts.ts` schemas, tool names, output fields, and Trace schema
  version as public compatibility surfaces. Add migrations or an explicit
  status entry before changing stored SQLite fields or Trace meaning.
- Keep the `agent-workflow` and `agent-workflow-mcp` wrapper install paths in
  `flake.nix` synchronized with `src/cli.ts` and `src/server.ts`.
- A release check must run the same deterministic test suite as local `npm run
  check`; Nix `doCheck` invokes `npm test` after the build.

## Runtime boundaries

- Provider wiring belongs in the host integration through
  `AGENT_WORKFLOW_CODEX_CONFIG_JSON`; do not bake host secrets, NixOS, systemd,
  worktree-delivery, or PATH policy into this repository's MVP.
- Keep `AGENT_WORKFLOW_MCP_SERVER_NAME` recursion prevention and
  `AGENT_WORKFLOW_CODEX_PATH`/`AGENT_WORKFLOW_CODEX_CONFIG_JSON` behavior
  compatible with `src/server.ts` and `src/agent-runner.ts`.
- Keep state under the configured `AGENT_WORKFLOW_STATE_DIR` or the XDG state
  default from `src/state-path.ts`. Do not put runtime SQLite, journals, or
  checkpoint Git repositories in the Workspace repository.
- Rollout and delivery target this repository's `origin/main`; the outer
  `nixos-config` task consumes the delivered revision separately.

## References and verification

- `AGENTS.md` — current MVP scope and prohibited integration surfaces.
- `README.md` — user-visible protocol, route, lifecycle, Trace, and status
  caveats.
- `package.json`, `package-lock.json`, and `flake.nix` — dependency/build/
  packaging contract.
- `src/server.test.ts`, `src/trace.test.ts`, and `src/spec-coverage.test.ts` —
  compatibility and read-model regression coverage.
- `.github/workflows/` — repository CI entry points; keep local and CI checks
  aligned when adding release gates.

## Avoid

- Do not claim production readiness or full specification conformance from the
  candidate implementation's current test coverage.
- Do not silently alter model profiles, reasoning effort, protocol revisions,
  stored state meaning, or Trace unknown-value semantics.
- Do not edit generated package output as a substitute for changing TypeScript
  source and the Nix/npm build inputs.
