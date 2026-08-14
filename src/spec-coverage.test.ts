import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("maps every normative clause to tests or an explicit implementation limit", () => {
  const draft = readFileSync(join(root, "spec", "DRAFT.zh-CN.md"), "utf8");
  const coverage = JSON.parse(
    readFileSync(
      join(root, "spec", "reference-implementation-coverage.json"),
      "utf8",
    ),
  ) as {
    clauses: Record<
      string,
      {
        status:
          | "tested"
          | "partial"
          | "implementation_defined"
          | "external"
          | "not_implemented";
        evidence: string[];
      }
    >;
  };
  const normativeIds = [
    ...new Set(
      [...draft.matchAll(/\*\*([A-Z]{3}-[0-9]{3})\*\*/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ].sort();
  const mappedIds = Object.keys(coverage.clauses).sort();

  assert.equal(normativeIds.length, 33);
  assert.deepEqual(mappedIds, normativeIds);
  for (const [id, entry] of Object.entries(coverage.clauses)) {
    assert.ok(entry.evidence.length > 0, `${id} must cite evidence or a limit`);
    for (const path of entry.evidence) {
      assert.equal(existsSync(join(root, path)), true, `${id}: missing ${path}`);
    }
  }
});
