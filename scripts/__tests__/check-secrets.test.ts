import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const scanner = resolve("scripts/check-secrets.mjs");

function scanTrackedFixture(contents: string) {
  const repository = mkdtempSync(join(tmpdir(), "zeros-secret-scan-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    writeFileSync(join(repository, "fixture.txt"), contents, "utf8");
    execFileSync("git", ["add", "fixture.txt"], { cwd: repository });
    return spawnSync(process.execPath, [scanner], {
      cwd: repository,
      encoding: "utf8",
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

describe("check-secrets WorkOS credentials", () => {
  it.each([
    `sk_test_${"Ab3dEf5hJk7mNp9qRs2uVw4yXz6BcD8fGh1J"}`,
    `sk_${"J7mNp9qRs2uVw4yXz6BcD8fGh1Kk3Aa5Ee7H"}`,
  ])("rejects a realistic tracked WorkOS API key", (key) => {
    const result = scanTrackedFixture(`WORKOS_API_KEY=${key}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("WorkOS");
    expect(result.stderr).not.toContain(key);
  });

  it("allows an obvious key-shaped placeholder", () => {
    const result = scanTrackedFixture(
      `WORKOS_API_KEY=sk_test_${"x".repeat(40)}\n`,
    );

    expect(result.status).toBe(0);
  });
});
