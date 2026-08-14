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

test("preserves an Agent report and rejects a different structured outcome", (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-journal-report-"));
  const result = join(root, "result.md");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    result,
    "# Full report\n\nDECISIVE_EVIDENCE_REFERENCE remains durable.\n",
    "utf8",
  );

  ensureResult(
    result,
    "worker",
    {
      status: "completed",
      summary: "The requested work is complete",
      questions: [],
      blocker: null,
    },
    { preserveExisting: true },
  );
  const finalized = readFileSync(result, "utf8");
  assert.match(finalized, /agent-workflow-controller-result:v1/);
  assert.match(finalized, /DECISIVE_EVIDENCE_REFERENCE/);

  assert.throws(
    () =>
      ensureResult(
        result,
        "worker",
        {
          status: "completed",
          summary: "A contradictory replacement summary",
          questions: [],
          blocker: null,
        },
        { preserveExisting: true, acceptFinalized: true },
      ),
    /differs from its structured outcome/,
  );
});
