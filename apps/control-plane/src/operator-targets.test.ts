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
  validateWorkOSProviderErasureRequest,
  workOSProviderErasureApprovalText,
} from "./manage-workos-provider-erasure";
import { resetTargetFingerprint } from "./reset-database";

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

});
