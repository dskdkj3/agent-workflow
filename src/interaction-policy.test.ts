import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const policy = readFileSync(
  join(projectRoot, "skills", "use-agent-workflow", "SKILL.md"),
  "utf8",
);

test("Interaction policy uses Codex Code Mode callable tool names", () => {
  assert.match(policy, /await tools\.workflow_run\(/);
  assert.match(policy, /await tools\.workflow_recovery_decision\(/);
  assert.match(policy, /workflow\.run/);
  assert.match(policy, /workflow\.recovery_decision/);
});

test("Interaction policy fails closed after selecting Workflow", () => {
  assert.match(policy, /classified as requiring Workflow/);
  assert.match(policy, /must not execute the workspace task itself/);
  assert.match(policy, /Do not silently downgrade/);
  assert.match(policy, /remove the Worker or Verifier/);
});
