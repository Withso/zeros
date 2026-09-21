import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  validateStaffRoleRequest,
  staffRoleApprovalText,
} from "./manage-staff";
import {
  validateCloudWorkspaceEntitlementRequest,
  cloudWorkspaceEntitlementApprovalText,
} from "./manage-cloud-workspace-entitlement";
import {
  validateCloudWorkspaceQuotaRequest,
  cloudWorkspaceQuotaApprovalText,
} from "./manage-cloud-workspace-quota";
import { planCloudComputeGrant } from "./manage-cloud-compute-credit";
import {
  validateCloudWorkspaceObjectStorageRequest,
  cloudWorkspaceObjectStorageApprovalText,
} from "./manage-cloud-workspace-object-storage";
import {
  validateCloudWorkspaceObjectRotationRetry,
  cloudWorkspaceObjectRotationRetryApprovalText,
} from "./manage-cloud-workspace-object-rotation";
import {
  validateWorkOSProviderErasureRequest,
  workOSProviderErasureApprovalText,
} from "./manage-workos-provider-erasure";
import { resetTargetFingerprint } from "./reset-database";
import {
  manageCloudAgentRuntime,
  type CloudAgentRuntimeChange,
} from "./manage-cloud-agent-runtime";

const fixture = new URL("postgresql://cluster.pg.psdb.cloud:5432/postgres?sslmode=verify-full");
fixture.username = "reviewer.branchalpha";
fixture.password = "synthetic";
const a = fixture.toString();
const b = a.replace("branchalpha", "branchbeta");
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = {
  channel: "alpha",
  railwayEnvironmentName: "alpha",
  execute: false,
  organizationId: id(1),
  actorUserId: id(2),
  expectedOrganizationSlug: "synthetic-organization",
  reason: "Synthetic operator review approval binding only",
};
const plans: Record<string, (databaseUrl: string) => string> = {
  staff: (databaseUrl) =>
    staffRoleApprovalText(
      validateStaffRoleRequest({
        ...base,
        databaseUrl,
        subjectUserId: id(3),
        expectedEmail: "synthetic@example.test",
        nextRole: "developer",
      }),
      null,
    ),
  entitlement: (databaseUrl) =>
    cloudWorkspaceEntitlementApprovalText(
      validateCloudWorkspaceEntitlementRequest({
        ...base,
        databaseUrl,
        plan: "business",
        status: "active",
        validFrom: "2026-01-01T00:00:00Z",
        validUntil: "2030-01-01T00:00:00Z",
        seatLimit: "2",
        activeSeatUserIds: `${id(3)},${id(4)}`,
      }),
      null,
    ),
  quota: (databaseUrl) =>
    cloudWorkspaceQuotaApprovalText(
      validateCloudWorkspaceQuotaRequest({
        ...base,
        databaseUrl,
        maxWorkspaces: "8",
        maxRunningWorkspaces: "4",
        maxCpuMillicores: "16000",
        maxMemoryMiB: "32768",
        maxStorageMiB: "163840",
      }),
      null,
    ),
  credit: (databaseUrl) =>
    planCloudComputeGrant(databaseUrl, {
      channel: "alpha",
      fundingScope: "user",
      userId: id(3),
      actorUserId: id(2),
      startsAt: "2026-09-01T00:00:00Z",
      endsAt: "2026-10-01T00:00:00Z",
      amountMicroUsd: 20_000_000,
      policyId: "synthetic-policy",
      idempotencyKey: "synthetic-receipt",
      reason: base.reason,
    }).digest,
  storage: (databaseUrl) =>
    cloudWorkspaceObjectStorageApprovalText(
      validateCloudWorkspaceObjectStorageRequest({
        ...base,
        databaseUrl,
        maxOrganizationBytes: "107374182400",
        maxWorkspaceBytes: "10737418240",
      }),
      null,
    ),
  rotation: (databaseUrl) =>
    cloudWorkspaceObjectRotationRetryApprovalText(
      validateCloudWorkspaceObjectRotationRetry({
        ...base,
        databaseUrl,
        blobId: id(4),
        targetKeyVersion: "2",
        objectKeysJson: JSON.stringify({
          1: Buffer.alloc(32, 1).toString("base64url"),
          2: Buffer.alloc(32, 2).toString("base64url"),
        }),
        currentObjectKeyVersion: "2",
      }),
      "a".repeat(32),
    ),
  erasure: (databaseUrl) =>
    workOSProviderErasureApprovalText(
      validateWorkOSProviderErasureRequest({
        ...base,
        databaseUrl,
        deletionRequestId: id(4),
        disposition: "fenced",
        subjectsJson: JSON.stringify([{ kind: "user", id: "user_synthetic" }]),
        evidenceReference: "SYNTHETIC-123456 provider evidence",
      }),
    ),
  reset: (databaseUrl) => resetTargetFingerprint(databaseUrl, "alpha"),
};
describe("operator target review: no database connections", () => {
  it.each(Object.keys(plans))(
    "%s approval distinguishes routed branches",
    (name) => {
      expect(plans[name]!(a)).not.toBe(plans[name]!(b));
    },
  );
  it.each(Object.keys(plans))("%s rejects driver routing override", (name) => {
    expect(() => plans[name]!(a + "&user=reviewer.branchbeta")).toThrow();
  });
  it("runtime qualification rejects driver routing override before pool use", async () => {
    const request: CloudAgentRuntimeChange = {
      operationId: randomUUID(),
      actorUserId: id(2),
      enabled: true,
      reason: base.reason,
      evidence: {
        version: 1,
        channel: "alpha",
        provider: "boat",
        runtimeClass: "linux-vm",
        imageRef: `boat:synthetic@sha256:${"a".repeat(64)}`,
        profile: "zeros-cloud-worker-v3",
        runtimeContractSha256: "b".repeat(64),
        sourceCommit: "c".repeat(40),
        evidenceSha256: "d".repeat(64),
        qualifiedAt: new Date().toISOString(),
        credentials: [
          {
            kind: "cursor-api-key",
            renewal: false,
            checks: {
              privateCredentialIsolation: true,
              workloadCredentialDenial: true,
              actorAdmission: true,
              stopAndRevocation: true,
              nativeTurn: true,
              nativeResume: true,
              authentication: true,
            },
          },
        ],
      },
    };
    let connected = false;
    const pool = {
      connect: async () => {
        connected = true;
        throw new Error("synthetic pool sentinel");
      },
    };
    await manageCloudAgentRuntime(pool as never, request, {
      databaseUrl: a + "&user=reviewer.branchbeta",
      channel: "alpha",
    }).catch(() => {});
    expect(connected).toBe(false);
  });
});
