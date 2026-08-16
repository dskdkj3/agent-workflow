# Project-layer design

## Boundary

The implementation changes only project-local Trellis assets. TypeScript source
and runtime behavior remain unchanged. The root `AGENTS.md` is preserved
byte-for-byte; the project layer is additive beside it around
`skills/use-agent-workflow/`, `src/`, `spec/`, npm scripts, and Nix packaging.

## Spec taxonomy

Use one real repository layer, `.trellis/spec/workflow/`, with these topics:

- `interaction-policy.md` for the user-facing three-state policy and route
  consent boundary;
- `controller-state.md` for SQLite state, lease fencing, Agent artifacts,
  checkpoints, compaction, and recovery;
- `agent-runner-codex.md` for the `AgentRunner` seam and Codex isolation;
- `mcp-trace.md` for public MCP tools, protocol compatibility, and the single
  Trace read model;
- `testing-evidence.md` for fake-runner tests, Evidence References, and the
  33-clause coverage map;
- `release-compatibility.md` for Node/npm/Nix packaging and public compatibility.

`.trellis/spec/guides/` keeps cross-layer reasoning, reuse/ownership, and
evidence/recovery guides. Each topic index names its Pre-Development Checklist,
references, anti-patterns, and quality commands.

## Generated asset adjustments

- Keep Trellis-generated scripts/skills and `.codex/hooks.json` portable.
- Add the wrapper marker guard at the first executable path of
  `inject-workflow-state.py`, `inject-subagent-context.py`, and
  `session-start.py`. It must use `os.environ.get(...) == "1"`, return code 0,
  and write nothing when active.
- Keep the marker absent path behavior equivalent apart from the early guard.
- Set all three agent model/reasoning pairs explicitly to Luna/max and state
  that an explicit caller may upgrade to Sol after material failure or
  irreducible judgment. Record the project default and fresh-context rule in
  `.trellis/config.yaml` and agent instructions without pretending Trellis
  parses unsupported keys.

## Task state

The child task remains `in_progress` after `task.py start`; this records that
the implementation is active but does not imply commit or delivery. The outer
task owns integration and operator rollout.
