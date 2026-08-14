import assert from "node:assert/strict";
import test from "node:test";

import { initialOrchestratorPrompt } from "./prompts.js";

test("Orchestrator routing policy separates task shape from topic labels", () => {
  const prompt = initialOrchestratorPrompt({
    request: "Audit one repository against an explicit specification",
    workspace: "/tmp/workspace",
    journal: {
      directory: "/tmp/task/orchestrator",
      task: "/tmp/task/orchestrator/task.md",
      journal: "/tmp/task/orchestrator/journal.md",
      result: "/tmp/task/orchestrator/result.md",
    },
  });

  assert.match(prompt, /bounded_execution -> Luna xhigh/);
  assert.match(prompt, /long_horizon_execution -> Luna max/);
  assert.match(prompt, /bounded_judgment -> Terra high/);
  assert.match(prompt, /irreducible_synthesis -> Sol high/);
  assert.match(prompt, /critical_deliberation -> Sol max/);
  assert.match(prompt, /do not justify Sol by themselves/);
  assert.match(prompt, /repository audit with an explicit rubric is normally bounded_judgment/);
  assert.match(prompt, /return "needs_input" instead of delegating unresolved intent/);
  assert.match(prompt, /why a lower-cost route is insufficient/);
  assert.match(prompt, /The Verifier route is independent/);
  assert.match(prompt, /do not reproduce the whole conversation/);
});
