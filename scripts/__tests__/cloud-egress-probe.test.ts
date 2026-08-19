import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const probe = path.join(
  process.cwd(),
  "scripts/cloud-workspace-validation/sandbox/egress-probe.sh",
);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runWithCurl(output: string, exitCode: number) {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-egress-probe-"));
  roots.push(root);
  const curl = path.join(root, "curl");
  writeFileSync(
    curl,
    `#!/bin/sh\nprintf '%s' '${output}'\nexit ${exitCode}\n`,
    "utf8",
  );
  chmodSync(curl, 0o755);
  return spawnSync("/bin/bash", [probe], {
    encoding: "utf8",
    env: { PATH: root },
  });
}

describe("cloud egress probe", () => {
  it("accepts a real HTTP response even when it is an authorization error", () => {
    const result = runWithCurl("401", 0);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reachable");
    expect(result.stdout).not.toContain("\u001b[31mBLOCKED");
  });

  it("returns nonzero and never labels a failed curl as reachable", () => {
    const result = runWithCurl("000", 7);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("BLOCKED");
    expect(result.stdout).not.toContain("reachable\u001b[0m (HTTP 000000)");
  });
});
