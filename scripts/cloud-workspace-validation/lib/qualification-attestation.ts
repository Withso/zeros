export const CLOUD_QUALIFICATION_CHECKS = Object.freeze([
  "image-contract",
  "runtime-attestation",
  "strict-account-jwt",
  "cloud-bridge",
  "file-rpc",
  "pty",
  "private-repository-github-app",
  "claude-live-turn",
  "codex-live-turn",
  "cursor-live-turn",
  "egress",
  "private-preview",
  "stop-wake",
  "generation-rollback-primitives",
  "authenticated-wss-soak",
  "ssh-local-forward",
  "production-setup-worker",
  "production-engine-registration",
  "production-engine-heartbeat",
] as const);

export type CloudQualificationDisposition =
  | "rehearsal"
  | "release-candidate";

type SnapshotIdentity = {
  readonly version: 1;
  readonly snapshotId: string;
  readonly snapshotName: string;
  readonly snapshotImageName: string;
  readonly snapshotState: string;
  readonly baseImage: string;
  readonly repositoryUrlSha256: string;
  readonly repositoryRef: string;
  readonly sourceCommit: string;
  readonly imageContractSha256: string;
  readonly bakedAt: string;
};

type RuntimeIdentity = {
  readonly region: string;
  readonly snapshotId: string;
  readonly snapshotImageName: string;
  readonly runtimeAttestationSha256: string;
};

type WorkflowIdentity = {
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly ref: string;
  readonly sha: string;
};

function safeString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    !/[\0\r\n]/.test(value)
  );
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function runPart(value: string): boolean {
  return /^[1-9][0-9]{0,19}$/.test(value);
}

export function createCloudQualificationAttestation(input: {
  readonly disposition: CloudQualificationDisposition;
  readonly snapshot: SnapshotIdentity;
  readonly runtime: RuntimeIdentity;
  readonly workflow: WorkflowIdentity;
  readonly qualifiedAt: string;
}) {
  const qualifiedAtMs = Date.parse(input.qualifiedAt);
  const bakedAtMs = Date.parse(input.snapshot.bakedAt);
  const expectedSnapshotName = `zeros-zsr-${
    input.disposition === "release-candidate" ? "candidate" : "ci"
  }-${input.workflow.runId}-${input.workflow.runAttempt}`;
  if (
    !["rehearsal", "release-candidate"].includes(input.disposition) ||
    input.snapshot.version !== 1 ||
    !safeString(input.snapshot.snapshotId, 512) ||
    !safeString(input.snapshot.snapshotName, 256) ||
    input.snapshot.snapshotName !== expectedSnapshotName ||
    !safeString(input.snapshot.snapshotImageName, 512) ||
    input.snapshot.snapshotState.toLowerCase() !== "active" ||
    !safeString(input.snapshot.baseImage, 1_024) ||
    !sha256(input.snapshot.repositoryUrlSha256) ||
    !safeString(input.snapshot.repositoryRef, 512) ||
    !/^[a-f0-9]{40,64}$/.test(input.snapshot.sourceCommit) ||
    !sha256(input.snapshot.imageContractSha256) ||
    !Number.isFinite(bakedAtMs) ||
    !safeString(input.runtime.region, 64) ||
    input.runtime.snapshotId !== input.snapshot.snapshotId ||
    input.runtime.snapshotImageName !== input.snapshot.snapshotImageName ||
    !sha256(input.runtime.runtimeAttestationSha256) ||
    !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(
      input.workflow.repository,
    ) ||
    !runPart(input.workflow.runId) ||
    !runPart(input.workflow.runAttempt) ||
    input.workflow.ref !== "refs/heads/main" ||
    input.workflow.sha !== input.snapshot.sourceCommit ||
    !Number.isFinite(qualifiedAtMs) ||
    qualifiedAtMs < bakedAtMs
  ) {
    throw new Error("cloud qualification attestation input is invalid");
  }

  return {
    version: 1 as const,
    result: "qualified" as const,
    profile: "zeros-phase-2-daytona-v1" as const,
    disposition: input.disposition,
    provider: {
      name: "daytona" as const,
      target: input.runtime.region,
      snapshotId: input.snapshot.snapshotId,
      snapshotName: input.snapshot.snapshotName,
      snapshotImageName: input.snapshot.snapshotImageName,
      snapshotState: input.snapshot.snapshotState,
    },
    image: {
      architecture: "linux/amd64" as const,
      baseImage: input.snapshot.baseImage,
      sourceCommit: input.snapshot.sourceCommit,
      repositoryRef: input.snapshot.repositoryRef,
      repositoryUrlSha256: input.snapshot.repositoryUrlSha256,
      imageContractSha256: input.snapshot.imageContractSha256,
      runtimeAttestationSha256: input.runtime.runtimeAttestationSha256,
      bakedAt: input.snapshot.bakedAt,
    },
    identity: {
      contract: "zeros-access-v1" as const,
      issuerClass: "ephemeral-nonproduction" as const,
    },
    checks: [...CLOUD_QUALIFICATION_CHECKS],
    workflow: { ...input.workflow },
    qualifiedAt: input.qualifiedAt,
  };
}
