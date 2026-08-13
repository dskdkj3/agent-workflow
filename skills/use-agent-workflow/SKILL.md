---
name: use-agent-workflow
description: Route user requests between direct Interaction handling and the `workflow.run` MCP backend while minimizing user coordination and attention. Use when Codex is the user-facing Interaction Agent and agent-workflow is available, especially for workspace execution, long exploration, independent verification, or requests that benefit from isolated backend context.
---

# Use Agent Workflow

Act as the user's discussion partner and front door. Preserve the user's attention by handling coordination internally and returning only decision-relevant outcomes.

## Route the request

- Handle simple facts, explanations, lightweight writing, and clearly self-contained conversational requests directly.
- Call `workflow.run` when the request needs workspace execution, substantial exploration, isolated Worker context, or independent verification.
- Select `execution_route: "single_worker"` only when the normalized request already has a narrow scope, needs no intent interpretation or decomposition, and includes observable `completion_criteria`. This route uses one Luna Max Worker and a fresh Luna Max Verifier.
- Use the default `execution_route: "orchestrated"` whenever an Orchestrator still has useful intent-compression, decomposition, coordination, architectural, security, or direction judgment to perform.
- Send a concise normalized request that preserves the goal, material constraints, and completion meaning. Do not forward the entire conversation when a shorter task description is sufficient.
- Generate and retain a UUID before calling `workflow.run`; pass it as `workflow_id`. If the MCP transport or backend process is interrupted, retry the identical request, workspace, route, and completion criteria with the same ID. Do not invent a replacement ID for a transport failure.

## Interact with the user

- Discuss and sharpen ambiguous requests naturally; do not force the user to fill a rigid task form.
- Proceed autonomously when no user decision is required.
- Ask only questions whose answers materially change the task. Ask multiple related questions when that is the clearest way to unblock the work; never impose a one-question limit.
- When the workflow returns `needs_input`, discuss the questions with the user and start a new `workflow.run` with a new ID and the clarified request. Process interruption is resumable; a terminal `needs_input` outcome is not a paused run.
- When a single-Worker result returns `retry_route: "orchestrated"`, immediately retry through the full route under a new `workflow_id`, with the same normalized request, completion meaning, current workspace, and the prior artifact path. Do not ask the user to coordinate that internal upgrade or present the intermediate route failure as the user-facing result.
- When `failure_kind` is `cyber_policy`, stop. Explain that the upstream safety classifier blocked the attempt and ask whether the user approves a semantically different recovery. Before approval, do not rephrase, split, reroute, retry, invoke a review route, start a replacement Workflow, or take over execution directly.
- After the user explicitly approves or denies, call `workflow.recovery_decision` with the failed `workflow_id`, a retained `decision_id`, the decision, and a concise note. Retry an approved recovery only as a new Workflow with a new `workflow_id` and visibly different semantics; a denial ends the attempt.

## Present the outcome

- Lead with the compressed conclusion or the next user decision.
- Include only information that can change the user's decision, understanding, or next action.
- Do not relay backend coordination, raw Agent logs, or full journals. Link artifact paths when detailed evidence may be useful.
- When the user asks how work was routed or what the backend is doing, direct them to the Workflow Trace instead of reconstructing history from chat. Treat measured, estimated, partial, and unknown accounting as distinct states.
- State failures, blockers, and remaining uncertainty plainly. Do not convert a provisional or rejected result into a success narrative.
