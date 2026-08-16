# Cross-layer change guide

For a change that crosses layers, write the data flow before editing:

```text
Interaction skill
  -> MCP schema/server
  -> Controller lease/state machine
  -> AgentRunner adapter
  -> task/journal/checkpoint artifacts
  -> Workflow Trace
  -> CLI/Web presentation
```

Then answer these repository-specific questions:

1. Is the user-facing decision documented in `skills/use-agent-workflow/` and
   covered by `src/interaction-policy.test.ts`?
2. Does the public MCP boundary in `src/server.ts` and `src/contracts.ts`
   remain backward compatible?
3. Which `StateStore` event, lease check, and checkpoint kind record the new
   lifecycle fact?
4. Does a fresh-context Verifier still receive independent evidence and does
   the Controller still gate `completed`?
5. Does `src/trace.ts` expose the fact once, with measured/partial/unknown
   provenance, and do all views consume it?
6. Which deterministic test and coverage-map entry prove the behavior?

If an answer is “none”, either keep the change local or stop and clarify the
missing contract. Do not silently widen a one-layer change into a new public
protocol.

References: `README.md`, `AGENTS.md`, `src/server.ts`, `src/controller.ts`,
`src/trace.ts`, `src/trace-format.ts`, and `src/trace-web.ts`.
