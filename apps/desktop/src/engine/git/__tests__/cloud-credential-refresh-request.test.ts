import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  requestCloudGithubCredentialRefresh,
  readCloudGithubCredentialRefreshRequest,
} from "../cloud-credential-refresh-request";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("cloud GitHub credential refresh request", () => {
  it("publishes a root-controlled, owner-bound, secret-free generation", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zeros-cloud-github-refresh-"),
    );
    roots.push(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "refresh.json");
    const uid = process.getuid?.() ?? 0;

    const request = requestCloudGithubCredentialRefresh({
      file,
      expectedUid: uid,
      ownerSubject: "account-owner",
      method: "github-app",
      reason: "credential-invalid",
      generation: "a".repeat(32),
      now: 1_800_000_000_000,
    });

    expect(request).toMatchObject({
      generation: "a".repeat(32),
      method: "github-app",
      reason: "credential-invalid",
    });
    expect(request.ownerSubjectSha256).toMatch(/^[a-f0-9]{64}$/);
    const handle = await open(file, "r");
    let serialized: string;
    try {
      const metadata = await handle.stat();
      expect(metadata.mode & 0o777).toBe(0o600);
      expect(metadata.nlink).toBe(1);
      serialized = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    expect(serialized).not.toContain("account-owner");
    expect(serialized).not.toMatch(/token|password|authorization/i);
    expect(
      readCloudGithubCredentialRefreshRequest({ file, expectedUid: uid }),
    ).toEqual(request);
  });

  it("atomically replaces an older generation", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zeros-cloud-github-refresh-"),
    );
    roots.push(root);
    const file = path.join(root, "refresh.json");
    const uid = process.getuid?.() ?? 0;
    requestCloudGithubCredentialRefresh({
      file,
      expectedUid: uid,
      ownerSubject: "owner",
      method: "github-app",
      reason: "credential-invalid",
      generation: "b".repeat(32),
      now: 1_800_000_000_000,
    });
    requestCloudGithubCredentialRefresh({
      file,
      expectedUid: uid,
      ownerSubject: "owner",
      method: "pat",
      reason: "credential-invalid",
      generation: "c".repeat(32),
      now: 1_800_000_000_001,
    });

    expect(
      readCloudGithubCredentialRefreshRequest({ file, expectedUid: uid }),
    ).toMatchObject({ generation: "c".repeat(32), method: "pat" });
  });
});
