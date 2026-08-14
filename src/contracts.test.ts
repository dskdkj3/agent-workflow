import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  agentOutcomeWireSchema,
  agentOutcomeSchema,
  fastWorkerOutcomeWireSchema,
  modelProfiles,
  orchestrationPlanWireSchema,
  orchestrationPlanSchema,
  storedOrchestrationPlanSchema,
  verificationOutcomeWireSchema,
  verificationOutcomeSchema,
  workflowRunOutputSchema,
} from "./contracts.js";

function workerRoute(taskClass: string) {
  return {
    task_class: taskClass,
    residual_burden: "Bounded fixture burden",
    why_lower_cost_route_is_insufficient: "The cheaper route lacks one required capability",
    upgrade_trigger: "Escalate if the bounded assumption stops holding",
  };
}

function verifierRoute(taskClass: string) {
  return {
    task_class: taskClass,
    residual_burden: "Independent fixture verification burden",
    why_lower_cost_route_is_insufficient: "The cheaper check cannot judge all evidence",
    upgrade_trigger: "Escalate if verification becomes system-defining",
  };
}

test("Structured Outputs wire schemas are root objects without oneOf", () => {
  for (const schema of [
    orchestrationPlanWireSchema,
    agentOutcomeWireSchema,
    fastWorkerOutcomeWireSchema,
    verificationOutcomeWireSchema,
  ]) {
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    assert.equal(json.type, "object");
    assert.equal(Object.hasOwn(json, "oneOf"), false);
    assert.deepEqual(
      new Set(json.required as string[]),
      new Set(Object.keys(json.properties as Record<string, unknown>)),
    );
  }

  const planJson = z.toJSONSchema(orchestrationPlanWireSchema) as Record<
    string,
    unknown
  >;
  const planProperties = planJson.properties as Record<string, unknown>;
  assert.equal(Object.hasOwn(planProperties, "worker_route"), true);
  assert.equal(Object.hasOwn(planProperties, "verifier_route"), true);
  assert.equal(Object.hasOwn(planProperties, "worker_profile"), false);
  assert.equal(Object.hasOwn(planProperties, "verifier_profile"), false);
});

test("rejects contradictory structured outcomes", () => {
  assert.throws(() =>
    verificationOutcomeSchema.parse({
      status: "passed",
      summary: "Claims success while reporting a finding",
      findings: [{ issue: "missing output", evidence: "file is absent" }],
      result_path: null,
      questions: [],
      blocker: null,
    }),
  );
  assert.throws(() =>
    agentOutcomeSchema.parse({
      status: "completed",
      summary: "Claims completion with a blocker",
      result_path: null,
      questions: [],
      blocker: "work is still blocked",
    }),
  );
  assert.throws(() =>
    orchestrationPlanSchema.parse({
      status: "ready",
      summary: "Claims readiness without a route",
      worker_task: "perform the task",
      worker_route: null,
      verifier_route: null,
      completion_criteria: ["result is observable"],
      questions: [],
      blocker: null,
    }),
  );

  const unknownUsageOutput = {
    workflow_id: "00000000-0000-4000-8000-000000000071",
    status: "failed",
    summary: "Usage was not observed",
    task_dir: "/tmp/agent-workflow-test",
    result_path: null,
    questions: [],
    blocker: "runner failed before reporting usage",
    usage_status: "unknown",
    execution_route: "orchestrated",
    retry_route: null,
    failure_kind: "execution_error",
    recovery_requires_user_approval: false,
  };
  assert.equal(
    workflowRunOutputSchema.parse({ ...unknownUsageOutput, usage: null }).usage,
    null,
  );
  assert.throws(() =>
    workflowRunOutputSchema.parse({
      ...unknownUsageOutput,
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    }),
  );
});

test("maps explicit task classes to fixed model profiles", () => {
  const workerCases = [
    ["short_bounded", "luna_high"],
    ["bounded_execution", "luna_xhigh"],
    ["long_horizon_execution", "luna_max"],
    ["bounded_judgment", "terra_high"],
    ["irreducible_synthesis", "sol_high"],
    ["critical_deliberation", "sol_max"],
  ] as const;
  const verifierCases = [
    ["mechanical_check", "luna_high"],
    ["bounded_evidence_review", "terra_high"],
    ["irreducible_review", "sol_high"],
    ["critical_review", "sol_max"],
  ] as const;

  for (const [workerClass, expectedWorker] of workerCases) {
    for (const [verifierClass, expectedVerifier] of verifierCases) {
      const plan = orchestrationPlanSchema.parse({
        status: "ready",
        summary: "Route fixture",
        worker_task: "Execute the route fixture",
        worker_route: workerRoute(workerClass),
        verifier_route: verifierRoute(verifierClass),
        completion_criteria: ["The route fixture is observable"],
        questions: [],
        blocker: null,
      });
      assert.equal(plan.worker_profile, expectedWorker);
      assert.equal(plan.verifier_profile, expectedVerifier);
    }
  }

  assert.equal(modelProfiles.luna_xhigh.reasoningEffort, "xhigh");
});

test("resumes legacy persisted plans without inventing routing rationale", () => {
  const plan = storedOrchestrationPlanSchema.parse({
    status: "ready",
    summary: "Legacy route fixture",
    worker_task: "Execute the legacy fixture",
    worker_profile: "luna_max",
    verifier_profile: "terra_high",
    completion_criteria: ["The legacy fixture is observable"],
    questions: [],
    blocker: null,
  });

  assert.equal(plan.worker_profile, "luna_max");
  assert.equal(plan.verifier_profile, "terra_high");
  assert.equal(plan.worker_route, null);
  assert.equal(plan.verifier_route, null);
});
