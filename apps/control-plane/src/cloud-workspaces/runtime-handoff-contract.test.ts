import { describe, expect, it } from "vitest";
import { CloudResidentWitnessSchema, detachedResident, sameResidentHost } from "./runtime-handoff-contract.js";

const hostId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const root = "/sys/fs/cgroup/system.slice/zeros-host.service";
const scopes = {
  legacy: `${root}/engine-workload-${hostId}`,
  current: `${root}/engine-runtime/engine-workload-${hostId}`,
} as const;
const resident = {
  hostId, organizationId: hostId, workspaceId: hostId, protocol: "zeros.resident-pty/v1",
  runtimeId: `r1-${"1".repeat(64)}`, manifestSha256: "1".repeat(64), bootId: hostId,
  supervisorSessionId: hostId, scope: scopes.current, fence: 1, engineId: hostId, generation: 1,
} as const;

describe("resident handoff scope compatibility", () => {
  it.each(Object.entries(scopes))("accepts exact %s attached and detached controller witnesses", (_kind, scope) => {
    const attached = { ...resident, scope };
    const detached = { ...attached, engineId: null, generation: null, fence: 2 };
    expect(CloudResidentWitnessSchema.safeParse(attached).success).toBe(true);
    expect(CloudResidentWitnessSchema.safeParse(detached).success).toBe(true);
    expect(detachedResident(attached, detached)).toBe(true);
  });

  it.each([
    root, `${root}/engine-runtime`, `${root}/engine-runtime/engine-workload-shared/workload`,
    `${root}/engine-runtime/engine-${hostId}`, `${root}/workload-${hostId}`,
    `${root}/engine-workload-${otherId}`, `${root}/engine-runtime/engine-workload-${otherId}`,
    `${scopes.legacy}/nested`, `${scopes.current}/nested`, `${scopes.current}/`,
    `${root}/engine-runtime/../engine-workload-${hostId}`,
    `/sys/fs/cgroup/foreign.service/engine-runtime/engine-workload-${hostId}`,
  ])("refuses a scope outside the two exact host-bound forms: %s", scope => {
    expect(CloudResidentWitnessSchema.safeParse({ ...resident, scope }).success).toBe(false);
  });

  it("keeps scope immutable across a detached receipt, including accepted layout forms", () => {
    const detached = { ...resident, scope: scopes.legacy, engineId: null, generation: null, fence: 2 };
    expect(CloudResidentWitnessSchema.safeParse(detached).success).toBe(true);
    expect(sameResidentHost(resident, detached)).toBe(false);
    expect(detachedResident(resident, detached)).toBe(false);
  });

  it.each(Object.values(scopes))("retains strict fields and runtime/authority correlation for %s", scope => {
    for (const change of [
      { token: "rejected" }, { runtimeId: `r1-${"2".repeat(64)}` }, { engineId: null },
      { generation: null }, { hostId: otherId }, { fence: 0 },
    ]) expect(CloudResidentWitnessSchema.safeParse({ ...resident, scope, ...change }).success).toBe(false);
  });
});
