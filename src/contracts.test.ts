import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  agentOutcomeWireSchema,
  agentOutcomeSchema,
  fastWorkerOutcomeWireSchema,
  orchestrationPlanWireSchema,
  orchestrationPlanSchema,
  verificationOutcomeWireSchema,
  verificationOutcomeSchema,
} from "./contracts.js";

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
      worker_profile: null,
      verifier_profile: null,
      completion_criteria: ["result is observable"],
      questions: [],
      blocker: null,
    }),
  );
});
