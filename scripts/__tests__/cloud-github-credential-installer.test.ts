import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installCloudGithubCredentialPayload,
  parseCloudGithubCredentialPayload,
} from "../cloud-workspace-validation/sandbox/install-cloud-github-credential.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function credentialDocument(now: number) {
  return {
    version: 1,
    audience: "zeros-cloud-github-credential-v1",
    generation: "github-credential-generation-1234",
    issuedAt: now,
    expiresAt: now + 60_000,
    ownerSubjectSha256: "a".repeat(64),
    method: "github-app",
    credential: {
      method: "github-app",
      accessToken: "ghu_short-lived-access-token",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
      login: "octocat",
      expiresAtMs: now + 45_000,
      variantKey: "github.com",
    },
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("immutable cloud GitHub credential installer", () => {
  it("accepts only a canonical short-lived owner-bound working credential", () => {
    const now = 1_800_000_000_000;
    const expected = credentialDocument(now);
    expect(
      parseCloudGithubCredentialPayload(encode(expected), {
        now,
        expectedOwnerSubjectSha256: "a".repeat(64),
      }),
    ).toEqual(expected);

    for (const value of [
      { ...expected, extra: true },
      { ...expected, expiresAt: now - 1 },
      { ...expected, expiresAt: now + 24 * 60 * 60_000 + 61_000 },
      { ...expected, ownerSubjectSha256: "b".repeat(64) },
      {
        ...expected,
        credential: { ...expected.credential, refreshToken: "must-not-cross" },
      },
      {
        ...expected,
        credential: { ...expected.credential, gitHost: "evil.example" },
      },
      {
        ...expected,
        credential: {
          ...expected.credential,
          expiresAtMs: expected.expiresAt + 1,
        },
      },
    ]) {
      expect(() =>
        parseCloudGithubCredentialPayload(encode(value), {
          now,
          expectedOwnerSubjectSha256: "a".repeat(64),
        }),
      ).toThrow(/cloud GitHub credential/i);
    }
  });

  it("supports an owner-bound explicit clear without accepting secret fields", () => {
    const now = 1_800_000_000_000;
    const clear = {
      ...credentialDocument(now),
      method: "pat",
      credential: null,
    };
    expect(
      parseCloudGithubCredentialPayload(encode(clear), {
        now,
        expectedOwnerSubjectSha256: "a".repeat(64),
      }),
    ).toEqual(clear);
  });

  it("atomically writes an owner-only physical file and refuses linked targets", () => {
    const now = Date.now();
    const root = mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-github-"));
    roots.push(root);
    const output = path.join(root, "github-credential.json");
    const expectedUid = statSync(root).uid;
    const document = credentialDocument(now);

    installCloudGithubCredentialPayload(encode(document), {
      output,
      expectedUid,
      expectedOwnerSubjectSha256: "a".repeat(64),
      now,
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(document);
    const stat = statSync(output);
    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);

    const target = path.join(root, "target");
    const symlink = path.join(root, "symlink");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, symlink);
    expect(() =>
      installCloudGithubCredentialPayload(encode(document), {
        output: symlink,
        expectedUid,
        expectedOwnerSubjectSha256: "a".repeat(64),
        now,
      }),
    ).toThrow(/not replaceable/i);

    const hardlink = path.join(root, "hardlink");
    linkSync(target, hardlink);
    expect(() =>
      installCloudGithubCredentialPayload(encode(document), {
        output: hardlink,
        expectedUid,
        expectedOwnerSubjectSha256: "a".repeat(64),
        now,
      }),
    ).toThrow(/not replaceable/i);
  });
});
