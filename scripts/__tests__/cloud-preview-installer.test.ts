import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
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

function readInstalledDocument(file: string): {
  readonly value: unknown;
  readonly file: boolean;
  readonly mode: number;
  readonly links: number;
} {
  const descriptor = openSync(file, "r");
  try {
    const metadata = fstatSync(descriptor);
    return {
      value: JSON.parse(readFileSync(descriptor, "utf8")),
      file: metadata.isFile(),
      mode: metadata.mode,
      links: metadata.nlink,
    };
  } finally {
    closeSync(descriptor);
  }
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
    const rootDescriptor = openSync(root, "r");
    let expectedUid: number;
    try {
      expectedUid = fstatSync(rootDescriptor).uid;
    } finally {
      closeSync(rootDescriptor);
    }

    installCloudPreviewLinkPayload(encode(document(now)), {
      output,
      expectedUid,
      now,
    });
    const installed = readInstalledDocument(output);
    expect(installed.value).toEqual(document(now));
    expect(installed.file).toBe(true);
    expect(installed.links).toBe(1);
    if (process.platform !== "win32") {
      expect(installed.mode & 0o777).toBe(0o600);
    }

    const rotated = {
      ...document(now),
      generation: "installer-test-generation-rotated",
    };
    installCloudPreviewLinkPayload(encode(rotated), {
      output,
      expectedUid,
      now,
    });
    expect(readInstalledDocument(output).value).toEqual(rotated);
  });
});
