# AgentRunner and Codex isolation

The Controller depends on the narrow `AgentRunner` interface in
`src/agent-runner.ts`; provider and SDK details stay behind
`CodexAgentRunner`. New lifecycle code should consume `AgentTurnResult`, not
Codex SDK event objects or provider-specific configuration.

## Backend Agent contract

- Every turn receives a role, allowlisted model profile, workspace, task
  directory, prompt, structured-output schema, and optional persistent
  `CODEX_HOME` plus lease identity.
- `CodexAgentRunner` starts or resumes a persistent thread and reports the
  `thread.started` identity before completion. The latest cumulative usage
  snapshot replaces the previous snapshot for that thread.
- Structured output is decoded as JSON and validated twice: JSON parsing in
  the adapter, then the role-specific Zod schema supplied by the Controller.
  Invalid output is a failed turn, not a best-effort result.
- Each backend Agent runs with `danger-full-access`, `approvalPolicy=never`,
  live network access, the requested workspace, and the Workflow task
  directory as an additional directory. These are explicit backend semantics;
  do not silently inherit a caller's interactive approval policy.
- Backend Agents disable Apps, plugins, Memories, and nested multi-agent
  features in `buildCodexBaseConfig`. A Workflow MCP server is replaced with a
  complete inert disabled stdio transport when recursion must be prevented.
- Preserve `max` as `max` through the generic config surface. The SDK type
  union may lag the Codex core, but `max` must never be downgraded to `xhigh`.

## Isolated homes and hook lifecycle

`prepareAgentCodexHome` creates an isolated writable home, copies only the
durable user instruction chain, links auth, and writes lease-bound lifecycle
hook configuration. Current runtime extensions must preserve this isolation and
must not make Stable or unrelated user state transitively visible.

## References and tests

- `src/agent-runner.ts` — adapter interface, model profiles, Codex thread
  options, config isolation, structured output, usage, and thread events.
- `src/codex-home.ts` — isolated home preparation and lifecycle hook config.
- `src/controller.ts` and `src/prompts.ts` — role boundaries and turn
  ownership; backend roles must not create or message agents.
- `src/agent-runner.test.ts` — Apps/plugins/Memories/subagent suppression,
  inert MCP transport, and real `xhigh` handling.
- `src/lifecycle-hook.test.ts` — isolated-home fallback and compact reload.
- `AGENTS.md` and `README.md` — project-level limits on provider wiring,
  user interaction, and live Codex probes.

## Avoid

- Do not import Codex SDK types into `src/state.ts`, `src/trace.ts`, or MCP
  schemas.
- Do not create a live-quota test when a fake `AgentRunner` can express the
  behavior.
- Do not enable Apps, plugins, Memories, or nested subagents for backend
  Agents, even if a provider config makes them available by default.
