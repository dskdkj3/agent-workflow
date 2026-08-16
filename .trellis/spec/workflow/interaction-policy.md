# Interaction and policy boundary

The Interaction layer is the user-facing front door. It decides whether a
turn is conversation, deliberation, or execution-ready before selecting a
backend route. The backend must not become a substitute for that judgment.

## Required behavior

- A subject, link, early thought, or bare “investigate this” opener is
  conversation. Do not inspect the workspace or call `workflow.run` merely
  because a plausible task can be written.
- A real goal with unresolved direction or durable design choices is
  deliberation. Read-only research may sharpen the recommendation, but the
  Interaction layer must not mutate the workspace or route execution until the
  user has clearly committed.
- Only execution-ready requests may call the MCP backend. Preserve the goal,
  material constraints, allowed scope, and completion meaning in the normalized
  request.
- Once a request is routed to Workflow, fail closed: the Interaction layer must
  not execute the task directly, remove the Worker or Verifier, or silently
  retry through a lower-quality path.
- `needs_input` travels back to the user. A `cyber_policy` failure requires an
  explicit `workflow.recovery_decision`; approval authorizes a semantically
  different new attempt and does not retry the failed Workflow.

These rules are the executable Interaction policy, not generic assistant
advice. Keep changes synchronized with the stable persona and interface
metadata.

## Route selection

Use `single_worker` only when the normalized request is already narrow,
execution-ready, and has observable `completion_criteria`. Otherwise use the
default `orchestrated` route so an Orchestrator can classify residual burden,
decompose the task, and record why a lower-cost route is insufficient. Topic
labels such as security or research are not model-selection evidence by
themselves.

## References and tests

- `skills/use-agent-workflow/SKILL.md` — state machine, route policy,
  fail-closed behavior, recovery decisions, and user-facing outcome rules.
- `skills/use-agent-workflow/references/interaction-persona.md` — stable
  language and attention boundary; do not add draft calibration material.
- `skills/use-agent-workflow/agents/openai.yaml` — installed skill metadata.
- `src/interaction-policy.test.ts` — regression tests for conversation versus
  deliberation, commitment, route choice, and callable tool names.
- `src/prompts.ts` and `src/recovery-prompts.ts` — backend role prompts that
  preserve the boundary after routing.
- `src/server.ts` and `src/server.test.ts` — public tool registration and
  structured outcome handoff.

## Avoid

- Do not turn a user correction or an added design requirement into an
  execution authorization without an explicit commitment.
- Do not let backend Agents contact the user, coordinate other Agents, use
  nested subagents, or claim that Verification already passed.
- Do not duplicate the entire Interaction skill in `src/`; the backend receives
  a normalized request and enforces lifecycle/safety invariants independently.
