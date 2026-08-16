import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installCloudPreviewLinkPayload,
  parseCloudPreviewLinkPayload,
} from "../cloud-workspace-validation/sandbox/install-cloud-preview-links.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function document(now: number) {
  return {
    version: 1,
    audience: "zeros-cloud-preview-v1",
    generation: "installer-test-generation-1234",
    issuedAt: now,
    expiresAt: now + 60_000,
    links: [
      {
        port: 41_000,
        signedUrl:
          "https://41000-signed-preview-token-41000.preview.example/",
      },
    ],
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("immutable cloud preview-link installer", () => {
  it("strictly validates the external coordinator payload", () => {
    const now = 1_800_000_000_000;
    expect(parseCloudPreviewLinkPayload(encode(document(now)), now)).toEqual(
      document(now),
    );
    for (const value of [
      { ...document(now), extra: true },
      { ...document(now), expiresAt: now - 1 },
      {
        ...document(now),
        links: [
          {
            ...document(now).links[0],
            signedUrl: "https://different.preview.example/",
          },
        ],
      },
      {
        ...document(now),
        links: [document(now).links[0], document(now).links[0]],
      },
    ]) {
      expect(() => parseCloudPreviewLinkPayload(encode(value), now)).toThrow(
        /preview link/i,
      );
    }
  });

  it("atomically writes an owner-only physical file", () => {
    const now = Date.now();
    const root = mkdtempSync(path.join(os.tmpdir(), "zeros-preview-install-"));
    roots.push(root);
    const output = path.join(root, "cloud-preview-links.json");
    const expectedUid = statSync(root).uid;

    installCloudPreviewLinkPayload(encode(document(now)), {
      output,
      expectedUid,
      now,
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(document(now));
    const stat = statSync(output);
    expect(stat.isFile()).toBe(true);
    expect(stat.nlink).toBe(1);
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);

    const rotated = {
      ...document(now),
      generation: "installer-test-generation-rotated",
    };
    installCloudPreviewLinkPayload(encode(rotated), {
      output,
      expectedUid,
      now,
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(rotated);
  });
});
