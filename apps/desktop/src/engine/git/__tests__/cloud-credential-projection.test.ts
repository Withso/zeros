import {
  chmodSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cloudOwnerSubjectSha256,
  readCloudGithubCredentialProjection,
} from "../cloud-credential-projection";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(now: number, ownerSubject: string) {
  return {
    version: 1,
    audience: "zeros-cloud-github-credential-v1",
    generation: "engine-projection-generation-1234",
    issuedAt: now,
    expiresAt: now + 60_000,
    ownerSubjectSha256: cloudOwnerSubjectSha256(ownerSubject),
    method: "pat" as const,
    credential: {
      method: "pat" as const,
      accessToken: "github_pat_short-lived-working-copy",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
      login: "octocat",
    },
  };
}

function writeFixture(value: unknown): {
  root: string;
  file: string;
  expectedUid: number;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-projection-"));
  roots.push(root);
  const file = path.join(root, "github-credential.json");
  writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return { root, file, expectedUid: process.getuid?.() ?? 0 };
}

describe("cloud GitHub credential projection", () => {
  it("reads only the matching unexpired physical owner-only projection", () => {
    const now = 1_800_000_000_000;
    const ownerSubject = "auth0|owner";
    const value = fixture(now, ownerSubject);
    const { file, expectedUid } = writeFixture(value);

    expect(
      readCloudGithubCredentialProjection({
        file,
        ownerSubject,
        expectedUid,
        now,
      }),
    ).toEqual(value);
  });

  it("rejects expired, cross-owner, over-permissive, linked, and public files", () => {
    const now = 1_800_000_000_000;
    const ownerSubject = "auth0|owner";
    const cases: unknown[] = [
      { ...fixture(now, ownerSubject), expiresAt: now - 1 },
      { ...fixture(now, "auth0|different") },
      {
        ...fixture(now, ownerSubject),
        credential: {
          ...fixture(now, ownerSubject).credential,
          refreshToken: "must-not-cross",
        },
      },
    ];
    for (const value of cases) {
      const { file, expectedUid } = writeFixture(value);
      expect(() =>
        readCloudGithubCredentialProjection({
          file,
          ownerSubject,
          expectedUid,
          now,
        }),
      ).toThrow(/cloud GitHub credential/i);
    }

    const physical = writeFixture(fixture(now, ownerSubject));
    chmodSync(physical.file, 0o644);
    expect(() =>
      readCloudGithubCredentialProjection({
        file: physical.file,
        ownerSubject,
        expectedUid: physical.expectedUid,
        now,
      }),
    ).toThrow(/unsafe/i);

    const linked = writeFixture(fixture(now, ownerSubject));
    const alias = path.join(linked.root, "alias.json");
    symlinkSync(linked.file, alias);
    expect(() =>
      readCloudGithubCredentialProjection({
        file: alias,
        ownerSubject,
        expectedUid: linked.expectedUid,
        now,
      }),
    ).toThrow(/unsafe/i);

    const hardlinked = writeFixture(fixture(now, ownerSubject));
    linkSync(hardlinked.file, path.join(hardlinked.root, "other.json"));
    expect(() =>
      readCloudGithubCredentialProjection({
        file: hardlinked.file,
        ownerSubject,
        expectedUid: hardlinked.expectedUid,
        now,
      }),
    ).toThrow(/unsafe/i);
  });
});
