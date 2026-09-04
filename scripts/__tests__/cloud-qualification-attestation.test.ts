import { describe, expect, it } from "vitest";

import { createCloudQualificationAttestation } from "../cloud-workspace-validation/lib/qualification-attestation";

const COMMIT = "a".repeat(40);
const snapshot = {
  version: 1 as const,
  snapshotId: "snapshot-id",
  snapshotName: "zeros-zsr-candidate-123-1",
  snapshotImageName: "snapshot-image",
  snapshotState: "active",
  baseImage: "node:22@sha256:digest",
  repositoryUrlSha256: "b".repeat(64),
  repositoryRef: "main",
  sourceCommit: COMMIT,
  imageContractSha256: "c".repeat(64),
  bakedAt: "2026-08-23T12:00:00.000Z",
};

describe("cloud qualification attestation", () => {
  it("publishes only deployable identity and sanitized evidence", () => {
    const attestation = createCloudQualificationAttestation({
      disposition: "release-candidate",
      snapshot,
      runtime: {
        region: "eu",
        snapshotId: snapshot.snapshotId,
        snapshotImageName: snapshot.snapshotImageName,
        runtimeAttestationSha256: "d".repeat(64),
        // Deliberate extra properties model the bearer-bearing private state.
        cloudToken: "must-not-escape",
        previewToken: "must-not-escape",
      },
      workflow: {
        repository: "withso/zeros",
        runId: "123",
        runAttempt: "1",
        ref: "refs/heads/main",
        sha: COMMIT,
      },
      qualifiedAt: "2026-08-23T13:00:00.000Z",
    });

    expect(attestation.provider.snapshotId).toBe("snapshot-id");
    expect(attestation.checks).toContain("private-repository-github-app");
    expect(attestation.checks).toContain("production-setup-worker");
    expect(attestation.checks).toContain("production-engine-registration");
    expect(attestation.checks).toContain("production-engine-heartbeat");
    expect(JSON.stringify(attestation)).not.toContain("must-not-escape");
    expect(attestation).not.toHaveProperty("sandboxId");
  });

  it("rejects cross-run snapshot/runtime/source substitutions", () => {
    const rehearsalSnapshot = {
      ...snapshot,
      snapshotName: "zeros-zsr-ci-123-1",
    };
    const base = {
      disposition: "rehearsal" as const,
      snapshot: rehearsalSnapshot,
      runtime: {
        region: "eu",
        snapshotId: rehearsalSnapshot.snapshotId,
        snapshotImageName: rehearsalSnapshot.snapshotImageName,
        runtimeAttestationSha256: "d".repeat(64),
      },
      workflow: {
        repository: "withso/zeros",
        runId: "123",
        runAttempt: "1",
        ref: "refs/heads/main",
        sha: COMMIT,
      },
      qualifiedAt: "2026-08-23T13:00:00.000Z",
    };
    expect(() =>
      createCloudQualificationAttestation({
        ...base,
        runtime: { ...base.runtime, snapshotId: "different" },
      }),
    ).toThrow(/invalid/);
    expect(() =>
      createCloudQualificationAttestation({
        ...base,
        workflow: { ...base.workflow, sha: "e".repeat(40) },
      }),
    ).toThrow(/invalid/);
    expect(() =>
      createCloudQualificationAttestation({
        ...base,
        snapshot: {
          ...rehearsalSnapshot,
          snapshotName: "zeros-zsr-ci-999-1",
        },
      }),
    ).toThrow(/invalid/);
    expect(() =>
      createCloudQualificationAttestation({
        ...base,
        snapshot: { ...rehearsalSnapshot, snapshotState: "inactive" },
      }),
    ).toThrow(/invalid/);
  });
});
