import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureResult } from "./journal.js";

test("replaces a result symlink without touching its external target", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-journal-"));
  const taskDir = join(root, "task");
  mkdirSync(taskDir);
  const external = join(root, "external.txt");
  const result = join(taskDir, "result.md");
  writeFileSync(external, "external content must remain unchanged\n", "utf8");
  symlinkSync(external, result);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  ensureResult(result, "worker", {
    status: "completed",
    summary: "fresh structured result",
    questions: [],
    blocker: null,
  });

  assert.equal(lstatSync(result).isFile(), true);
  assert.equal(lstatSync(result).isSymbolicLink(), false);
  assert.match(readFileSync(result, "utf8"), /fresh structured result/);
  assert.equal(
    readFileSync(external, "utf8"),
    "external content must remain unchanged\n",
  );
});
