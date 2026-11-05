import { describe, expect, it } from "vitest";
import { loadRuntimeRelease, runtimeReleaseIdentity } from "./runtime-release.js";

const release = { version: 1, sha256: "a".repeat(64), sourceSha: "b".repeat(40), sourceSha256: "c".repeat(64),
  qualification: { channel: "alpha", runId: "12345", runAttempt: 1, completedAt: "2026-11-01T00:00:00.000Z",
    receiptSha256: "d".repeat(64), deleted: true } };

describe("runtime release identity metadata", () => {
  it("requires cleanup proof and the exact pinned digest", () => {
    const record = loadRuntimeRelease(JSON.stringify(release));
    expect(runtimeReleaseIdentity({ sha256: release.sha256, release: record })).toMatchObject({ workerQualified: true,
      worker: { sha256: release.sha256, sourceSha: release.sourceSha, qualification: release.qualification } });
    expect(runtimeReleaseIdentity({ sha256: "e".repeat(64), release: record })).toMatchObject({ workerQualified: false,
      worker: { sha256: "e".repeat(64), sourceSha: null, qualification: null } });
    expect(() => loadRuntimeRelease(JSON.stringify({ ...release, qualification: { ...release.qualification, deleted: false } }))).toThrow();
  });

  it.each([undefined, "", "  "])("keeps legacy configuration unqualified: %s", raw => {
    expect(loadRuntimeRelease(raw)).toBeUndefined();
    expect(runtimeReleaseIdentity({ sha256: release.sha256 })).toMatchObject({ workerQualified: false, worker: { sourceSha: null } });
    expect(runtimeReleaseIdentity(undefined)).toEqual({ worker: null, workerQualified: false });
  });

  it.each([
    { ...release, accessToken: "synthetic-sensitive" },
    { ...release, sourceSha: "synthetic-sensitive" },
    { ...release, qualification: { ...release.qualification, channel: "production" } },
    { ...release, qualification: { ...release.qualification, output: "synthetic-sensitive" } },
  ])("rejects non-public or unsupported metadata without echoing it", value => {
    expect(() => loadRuntimeRelease(JSON.stringify(value))).toThrow("Invalid environment: CLOUD_V2_RUNTIME_RELEASE_METADATA");
    expect(JSON.stringify(runtimeReleaseIdentity({ sha256: release.sha256, release: value as never }))).not.toContain("synthetic-sensitive");
  });
});
