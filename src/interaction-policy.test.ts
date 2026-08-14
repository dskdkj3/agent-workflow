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
const interfaceMetadata = readFileSync(
  join(
    projectRoot,
    "skills",
    "use-agent-workflow",
    "agents",
    "openai.yaml",
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
    policy.indexOf("## Establish the interaction state before routing") <
      policy.indexOf("## Route the request"),
  );
  assert.match(policy, /subject, link, early thought, preference, or interest/);
  assert.match(policy, /remains `conversation`/);
  assert.match(policy, /do not inspect first/);
  assert.match(policy, /state decision precedes route selection/);
  assert.match(persona, /我想调查一下某个链接/);
  assert.match(persona, /工具动作也算开始做事/);
  assert.match(persona, /只有一个对象和一句“想调查”，先别动手/);
});

test("Interaction keeps design deliberation distinct from execution commitment", () => {
  const regressionPrompt =
    "我想在codex-cli更新新版本的时候用我现成的bark提醒我";
  const deliberationFollowup =
    "改成一小时，状态持久化，同时看看 npm 和 GitHub，跑在 desktop";

  assert.match(regressionPrompt, /我想在codex-cli更新新版本/);
  assert.match(deliberationFollowup, /状态持久化/);
  assert.ok(
    policy.indexOf("## Establish the interaction state before routing") <
      policy.indexOf("## Route the request"),
  );
  assert.match(policy, /`conversation`/);
  assert.match(policy, /`deliberation`/);
  assert.match(policy, /`execution_ready`/);
  assert.match(policy, /Persistent automation, monitoring/);
  assert.match(policy, /not execution authorization by themselves/);
  assert.match(policy, /do not mutate the workspace or call `workflow\.run`/);
  assert.match(policy, /general bias toward autonomous execution applies only after/);
  assert.match(policy, /Do more than collect missing fields/);
  assert.match(policy, /never treat your own confidence as user authorization/);
  assert.match(persona, /一个愿望已经说清楚，也不等于已经到了执行/);
  assert.match(persona, /不等于他说了“现在开始做”/);
  assert.match(persona, /不要只把用户的话整理得更专业/);
});

test("Interaction grounds advice in the existing system and actionable event", () => {
  assert.match(policy, /actual system, not a generic greenfield design/);
  assert.match(policy, /real system of record/);
  assert.match(policy, /current install or consumption path/);
  assert.match(policy, /external event being observed/);
  assert.match(policy, /point where it becomes consumable or actionable/);
  assert.match(policy, /Multiple sources may corroborate one event/);
  assert.match(policy, /a provisional problem model, a recommendation, an objection/);
  assert.match(policy, /Questions should test or refine that contribution/);
  assert.match(policy, /do not turn deliberation into an exhaustive audit/);
  assert.match(persona, /“我现成的”“接进现在这套”“沿用已有的”/);
  assert.match(persona, /官网最常见的安装方式/);
  assert.match(persona, /上游发了版本、包源已经发布/);
  assert.match(persona, /现在有没有什么值得我行动/);
  assert.match(persona, /所谓一起 battle/);
  assert.match(persona, /不只是任务说明越来越长/);
});

test("Interaction skill metadata invites deliberation rather than silent completion", () => {
  assert.match(interfaceMetadata, /Deliberate with users, then route execution/);
  assert.match(interfaceMetadata, /thoughtful user-facing adviser/);
  assert.match(interfaceMetadata, /work through unsettled intent/);
  assert.doesNotMatch(interfaceMetadata, /minimal user coordination/);
});

test("Interaction state remains an internal control rather than user-facing narration", () => {
  assert.match(policy, /Keep interaction-state labels and routing policy internal/);
  assert.match(policy, /do not announce that the request "remains in deliberation"/);
  assert.match(policy, /do not repeat it in the substantive answer/);
  assert.match(persona, /别把脑子里的状态机念出来/);
  assert.match(persona, /我还没改，刚才只是在把方案想清楚/);
});

test("single-Worker Interaction guidance uses the bounded Luna High route", () => {
  assert.match(policy, /one Luna High Worker and a fresh Luna High Verifier/);
  assert.doesNotMatch(policy, /one Luna Max Worker and a fresh Luna Max Verifier/);
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
