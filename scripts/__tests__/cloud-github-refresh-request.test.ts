import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  acknowledgeCloudGithubRefreshRequest,
  readCloudGithubRefreshRequest,
} from "../cloud-workspace-validation/sandbox/cloud-github-refresh-request.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function request(generation: string) {
  return {
    version: 1,
    audience: "zeros-cloud-github-refresh-v1",
    generation,
    requestedAt: 1_800_000_000_000,
    ownerSubjectSha256: "a".repeat(64),
    method: "github-app",
    reason: "credential-invalid",
  };
}

describe("immutable cloud GitHub refresh request helper", () => {
  it("does not change a symlink target's permissions while rejecting an acknowledgement", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zeros-github-refresh-"));
    roots.push(root);
    const target = path.join(root, "canary");
    const file = path.join(root, "request.json");
    writeFileSync(target, "unchanged", { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, file);
    expect(() =>
      acknowledgeCloudGithubRefreshRequest(file, "a".repeat(32), {
        expectedUid: statSync(root).uid,
      }),
    ).toThrow();
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(readFileSync(target, "utf8")).toBe("unchanged");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without waiting for a writer",
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "zeros-github-refresh-"));
      roots.push(root);
      const file = path.join(root, "request.json");
      expect(spawnSync("mkfifo", ["-m", "600", file]).status).toBe(0);
      const module = pathToFileURL(
        path.resolve(
          "scripts/cloud-workspace-validation/sandbox/cloud-github-refresh-request.mjs",
        ),
      ).href;
      const script = `import {readCloudGithubRefreshRequest} from ${JSON.stringify(module)};
      try {readCloudGithubRefreshRequest(${JSON.stringify(file)}, {expectedUid:${statSync(root).uid}}); process.exitCode=1;}
      catch {process.exitCode=0;}`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          encoding: "utf8",
          timeout: 1000,
          maxBuffer: 4096,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("reads only a physical owner-only request", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zeros-github-refresh-"));
    roots.push(root);
    chmodSync(root, 0o700);
    const file = path.join(root, "request.json");
    const expected = request("a".repeat(32));
    writeFileSync(file, `${JSON.stringify(expected)}\n`, { mode: 0o600 });
    const expectedUid = statSync(root).uid;

    expect(readCloudGithubRefreshRequest(file, { expectedUid })).toEqual(
      expected,
    );
    chmodSync(file, 0o644);
    expect(() => readCloudGithubRefreshRequest(file, { expectedUid })).toThrow(
      /unsafe/i,
    );
  });

  it("acknowledges only the exact generation and preserves a newer request", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "zeros-github-refresh-"));
    roots.push(root);
    chmodSync(root, 0o700);
    const file = path.join(root, "request.json");
    const expectedUid = statSync(root).uid;
    const current = request("b".repeat(32));
    writeFileSync(file, `${JSON.stringify(current)}\n`, { mode: 0o600 });

    expect(
      acknowledgeCloudGithubRefreshRequest(file, "a".repeat(32), {
        expectedUid,
      }),
    ).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(current);
    expect(
      acknowledgeCloudGithubRefreshRequest(file, "b".repeat(32), {
        expectedUid,
      }),
    ).toBe(true);
    expect(readCloudGithubRefreshRequest(file, { expectedUid })).toBeNull();
  });
});
