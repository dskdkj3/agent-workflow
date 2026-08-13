# Agent Workflow

This context defines the language shared by the Agent Workflow specification and its implementations. The specification describes guarantees; implementations choose how to provide them.

## Language

**Workflow Specification**:
The implementation-independent rules that define externally observable Agent Workflow guarantees.
_Avoid_: Reference implementation, controller architecture, Codex workflow

**Workflow Implementation**:
Software that provides the behavior defined by a particular Workflow Specification version.
_Avoid_: The workflow, the standard

**Interactive Implementation**:
A Workflow Implementation that also accepts unrefined user requests, discusses them with the user, and presents the final result.
_Avoid_: Interaction Agent

**Task Request**:
The stable statement of the objective, constraints, completion meaning, and available working scope accepted for execution.
_Avoid_: Prompt, user message, worker task

**Workflow Run**:
One accepted Task Request tracked from acceptance until exactly one Terminal Outcome.
_Avoid_: Thread, session, agent run

**Checkpoint**:
An ordered, durable account of the Workflow Run state that later work or recovery may rely on.
_Avoid_: Log line, chat summary, memory

**Journal**:
An Agent-maintained narrative of work performed, decisions, uncertainty, and intended next steps. A Journal can support recovery, but it is not authoritative for orchestration state or the Terminal Outcome.
_Avoid_: Workflow Trace, lifecycle ledger, memory

**Artifact**:
Durable task, result, or evidence material associated with a Workflow Run and addressable without replaying an Agent conversation.
_Avoid_: Chat transcript, ephemeral tool output

**Evidence Reference**:
A stable reference to material that supports or contradicts a claim about the Task Request or its result.
_Avoid_: Agent opinion, unsupported summary

**Verification**:
An evidence-based assessment that does not treat the executor's own completion claim as proof.
_Avoid_: Verifier Agent

**Terminal Outcome**:
The single final classification and user-relevant result of a Workflow Run.
_Avoid_: Final message, worker result, process exit code

**Progress Update**:
User-visible information about an ongoing Workflow Run that does not claim or imply a Terminal Outcome.
_Avoid_: Provisional result, early completion

**Execution Route**:
An implementation-selected way to perform a Workflow Run while preserving the same specification guarantees.
_Avoid_: Workflow type, protocol mode

**Workflow Trace**:
A read-only projection of the authoritative lifecycle facts for one Workflow Run, including provenance for facts that are measured, estimated, partial, or unknown.
_Avoid_: Journal, raw log, user interface

**Recovery Decision**:
The user's explicit approval or denial of a proposed recovery whose meaning differs materially from the failed attempt. It records authority to attempt recovery; it is not itself a retry or a successful result.
_Avoid_: Automatic retry, implicit consent
