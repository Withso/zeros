import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cloudOwnerSubjectSha256, installCloudGithubCredentialProjection,
  readCloudGithubCredentialProjection, watchCloudGithubCredentialProjection,
} from "../cloud-credential-projection";
import {
  acknowledgeCloudGithubCredentialRefreshRequest, readCloudGithubCredentialRefreshRequest,
  requestCloudGithubCredentialRefresh,
} from "../cloud-credential-refresh-request";

// Real temporary files, with only VM file ownership simulated. Callers use
// the same default options as ZerosEngine's live serve and heartbeat paths.
const identity = vi.hoisted(() => ({ uid: 10003 }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) =>
      Object.assign(fs.lstatSync(...args)!, { uid: identity.uid, gid: identity.uid }),
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) =>
      Object.assign(fs.fstatSync(...args), { uid: identity.uid, gid: identity.uid }),
  };
});
let root: string;
const now = 1_800_000_000_000;
const ownerSubject = "synthetic-owner";
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-github-identity-"));
  vi.spyOn(process, "getuid").mockImplementation(() => identity.uid);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it.each([10003, 0])("reads and rotates the current UID %i projection with engine default options", uid => {
  identity.uid = uid;
  const file = path.join(root, "github-credential.json");
  // The null credential still proves document admission without any secret.
  const document = { version: 1, audience: "zeros-cloud-github-credential-v1",
    generation: "synthetic-projection-generation", issuedAt: now, expiresAt: now + 60_000,
    ownerSubjectSha256: cloudOwnerSubjectSha256(ownerSubject), method: "pat", credential: null };
  writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
  expect(readCloudGithubCredentialProjection({ file, ownerSubject, now })).toEqual(document);
  const changed = vi.fn(), rejected = vi.fn();
  const watcher = watchCloudGithubCredentialProjection({ file, ownerSubject, now: () => now,
    onChange: changed, onRejected: rejected });
  try { expect(changed).toHaveBeenCalledWith(null, "pat"); expect(rejected).not.toHaveBeenCalled(); }
  finally { watcher.stop(); }
  expect(installCloudGithubCredentialProjection({ file, ownerSubject, now,
    document: { ...document, generation: "synthetic-rotated-generation" } }).generation)
    .toBe("synthetic-rotated-generation");
});

it.each([10003, 0])("publishes, reads, and acknowledges a UID %i refresh with engine default options", uid => {
  identity.uid = uid;
  const file = path.join(root, "github-credential-refresh.json");
  const request = requestCloudGithubCredentialRefresh({ file, ownerSubject, now,
    method: "github-app", reason: "credential-invalid" });
  expect(readCloudGithubCredentialRefreshRequest({ file })).toEqual(request);
  expect(acknowledgeCloudGithubCredentialRefreshRequest({ file, generation: request.generation })).toBe(true);
  expect(readCloudGithubCredentialRefreshRequest({ file })).toBeNull();
});

it("retains explicit ownership refusal", () => {
  identity.uid = 10003;
  expect(() => readCloudGithubCredentialRefreshRequest({
    file: path.join(root, "github-credential-refresh.json"), expectedUid: 0,
  })).toThrow(/directory is unsafe/);
});
