import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

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
    expect(() =>
      readCloudGithubRefreshRequest(file, { expectedUid }),
    ).toThrow(/unsafe/i);
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
