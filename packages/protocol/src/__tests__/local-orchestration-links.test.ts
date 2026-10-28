import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { extractLocalLinks } from "../local-orchestration";

it("preserves Local link punctuation and distinct channel identities", () => {
  expect(extractLocalLinks(
    "zeros://chat/one... zeros://chat/one: zeros-dev://workspace/two---",
  )).toEqual([
    { scheme: "zeros", kind: "chat", id: "one" },
    { scheme: "zeros-dev", kind: "workspace", id: "two" },
  ]);
});

it("bounds link extraction for long internal punctuation runs", () => {
  // Isolate the adversarial input so a quadratic matcher cannot hang the suite.
  // The budget includes Node/tsx startup and is far above the linear scan cost.
  const source = new URL("../local-orchestration.ts", import.meta.url).href;
  const code = `import assert from 'node:assert/strict';
    import { extractLocalLinks } from ${JSON.stringify(source)};
    assert.deepEqual(extractLocalLinks('zeros://chat/a' + '-'.repeat(250_000) + 'z zeros://chat/valid.'),
      [{ scheme: 'zeros', kind: 'chat', id: 'valid' }]);`;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { timeout: 4_000, encoding: "utf8", maxBuffer: 64 * 1024 },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 10_000);
