# Agent Workflow repository specs

This repository is a TypeScript MCP candidate reference implementation for a
durable Orchestrator/Worker/Verifier workflow. The specs below describe the
contracts that future changes must preserve; they do not replace the public
discussion draft in `spec/DRAFT.zh-CN.md` or the project onboarding rules in
`AGENTS.md`.

## Pre-Development Checklist

Before changing a file under `src/` or `skills/`:

1. Read `AGENTS.md` and the relevant section of `README.md`.
2. Classify the change using the topic map below. Read every linked topic
   spec before editing.
3. Trace the existing flow through source before introducing a new abstraction:
   MCP input in `src/server.ts`, validation in `src/contracts.ts`, lifecycle
   in `src/controller.ts` and `src/state.ts`, persistence in `src/journal.ts`
   and `src/checkpoints.ts`, and read projection in `src/trace.ts`.
4. Add or update deterministic tests under `src/*.test.ts`. Use a fake
   `AgentRunner` unless a task explicitly authorizes a live Codex probe.
5. Run `npm run check`, then the narrower checks named by the topic spec. Use
   `git diff --check` before handing the work back.

## Topic map

| Change area | Read first |
| --- | --- |
| User-facing routing, consent, or Interaction behavior | `interaction-policy.md` |
| Workflow lifecycle, leases, journals, or checkpoint recovery | `controller-state.md` |
| Codex SDK, model profiles, isolated homes, or backend Agent policy | `agent-runner-codex.md` |
| MCP tools, schemas, protocol compatibility, or Trace views | `mcp-trace.md` |
| Tests, Evidence References, or implementation-coverage claims | `testing-evidence.md` |
| npm/Nix release behavior or compatibility changes | `release-compatibility.md` |

The cross-cutting guides in `../guides/` are always applicable when a change
crosses two of these areas.

## Quality Check

```sh
npm run check
python3 -m compileall -q .codex/hooks .trellis/scripts
python3 - <<'PY'
import json
from pathlib import Path

json.loads(Path("spec/reference-implementation-coverage.json").read_text())
json.loads(Path(".codex/hooks.json").read_text())
PY
git diff --check
```

The coverage map is intentionally an implementation-status document, not a
conformance declaration. Update it when a source or test changes the status of
one of the 33 draft clauses.
