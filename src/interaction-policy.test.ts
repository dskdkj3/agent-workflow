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
const persona = readFileSync(
  join(
    projectRoot,
    "skills",
    "use-agent-workflow",
    "references",
    "interaction-persona.md",
  ),
  "utf8",
);

test("Interaction policy uses Codex Code Mode callable tool names", () => {
  assert.match(policy, /await tools\.mcp__agent_workflow__workflow_run\(/);
  assert.match(
    policy,
    /await tools\.mcp__agent_workflow__workflow_recovery_decision\(/,
  );
  assert.doesNotMatch(policy, /await tools\.workflow_run\(/);
  assert.doesNotMatch(policy, /await tools\.workflow_recovery_decision\(/);
  assert.match(policy, /workflow\.run/);
  assert.match(policy, /workflow\.recovery_decision/);
});

test("Interaction policy fails closed after selecting Workflow", () => {
  assert.match(policy, /classified as requiring Workflow/);
  assert.match(policy, /must not execute the workspace task itself/);
  assert.match(policy, /Do not silently downgrade/);
  assert.match(policy, /remove the Worker or Verifier/);
});

test("bare investigation opener is discussion, not tool authorization", () => {
  const regressionPrompt =
    "我想调查一下https://github.com/Proof-of-Ineffective-Input";

  assert.match(regressionPrompt, /^我想调查一下https:\/\//);
  assert.ok(
    policy.indexOf("## Accept the task before routing") <
      policy.indexOf("## Route the request"),
  );
  assert.match(policy, /A subject, link, interest, intention/);
  assert.match(policy, /requires a conversational response first/);
  assert.match(policy, /do not inspect the link or workspace/);
  assert.match(policy, /This acceptance gate precedes routing rules/);
  assert.match(persona, /我想调查一下某个链接/);
  assert.match(persona, /工具动作也算开始做事/);
  assert.match(persona, /只有一个对象和一句“想调查”，先别动手/);
});

test("runtime Interaction persona is a stable asset without draft material", () => {
  assert.match(persona, /你会和这个用户一起做很久的事/);
  assert.match(persona, /谈话不是需求录入/);
  assert.match(persona, /后端在你身后，不在用户面前/);
  assert.match(persona, /只有会改变用户决定、认知模型、信任或下一步的信息/);
  assert.doesNotMatch(persona, /状态：供用户审阅/);
  assert.doesNotMatch(persona, /编辑备注/);
  assert.doesNotMatch(persona, /calibration/i);
  assert.doesNotMatch(persona, /Few-shot/i);
});
