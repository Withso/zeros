import { afterEach, describe, expect, it } from "vitest";
import * as mirror from "./capability-actor-contract.js";
import * as shared from "../../../../packages/protocol/src/cloud-capability-sessions.js";
import { CloudCapabilityActorAdmissionResponseSchema } from "../../../../packages/protocol/src/cloud-actors.js";
import { testClientClaims, TEST_CAPABILITY_IDS as ids } from "./capability-verifier-test-utils.js";
import { flagEffective, ROLLOUT_FLAGS, type RolloutFlagReader } from "../rollout-flags.js";
import { capabilityActorSessionsEnabled, installCapabilityActorSessionFlags } from "./actor-session-authority.js";

const claims = testClientClaims();
const binding = { workspaceId: ids.workspace, organizationId: ids.org, generation: 7, engineInstanceId: ids.engine };
const response = { ...binding, version: 1, audience: mirror.CAPABILITY_SESSION_AUDIENCE,
  mode: "capability-session-v1", admitted: true, accountUserId: ids.user, actorSessionId: ids.session,
  deviceId: ids.device, authorityEpoch: 12, role: "developer", fingerprint: "a".repeat(64), route: "direct",
  capability: { claims, keyId: "cap-2026-10-a", tokenSha256: "b".repeat(64), revision: 1 } };
const request = { ...binding, version: 1, mode: "capability-session-v1", capability: "a".repeat(32)+".bbb.ccc",
  proof: { timestampMs: 1, nonce: "a".repeat(22), signature: "b".repeat(86) }, route: "direct" };

describe("capability actor session contracts and selection", () => {
  afterEach(() => installCapabilityActorSessionFlags());
  it("keeps both mirrors strict and rejects N-1 response conversion", () => {
    for (const [name, input, valid] of [
      ["CapabilitySessionResponseSchema", response, true],
      ["CapabilitySessionResponseSchema", { ...response, renewalToken: "zwa_"+"a".repeat(43) }, false],
      ["CapabilitySessionResponseSchema", { ...response, accountUserId: ids.device }, false],
      ["CapabilitySessionResponseSchema", { ...response, capability: { ...response.capability, claims: { ...claims, ep: { wa: 11, wr: 3, me: 5, ac: 1, dk: 2 } } } }, false],
      ["CapabilitySessionAdmissionRequestSchema", request, true],
      ["CapabilitySessionAdmissionRequestSchema", { ...request, actorSessionId: ids.session }, false],
      ["CapabilitySessionAdmissionRequestSchema", { ...request, mode: "legacy" }, false],
      ["CapabilitySessionRenewalRequestSchema", { ...request, actorSessionId: ids.session, expectedRevision: 1 }, true],
      ["CapabilitySessionRenewalRequestSchema", { ...request, actorSessionId: ids.session, expectedRevision: 0 }, false],
    ] as const) {
      const left = mirror[name].safeParse(input), right = shared[name].safeParse(input);
      expect(left.success).toBe(valid);
      expect(right.success).toBe(valid);
      if (left.success && right.success) expect(left.data).toEqual(right.data);
    }
    expect(CloudCapabilityActorAdmissionResponseSchema.safeParse(response).success).toBe(false);
    for (const key of ["CAPABILITY_SESSION_ADMISSION_PATH", "CAPABILITY_SESSION_RENEWAL_PATH", "CAPABILITY_SESSION_AUDIENCE"] as const)
      expect(mirror[key]).toBe(shared[key]);
  });

  it("defaults off and loses current authority on a missing dependency or stale flag feed", () => {
    expect(capabilityActorSessionsEnabled(ids.org)).toBe(false);
    const enabled = new Set(["capability_actor_sessions", "capabilities", "runtime_connect", "realtime_uplink"]);
    let current = true;
    const flags: RolloutFlagReader = { enabled: (org, flag) => org === ids.org && flagEffective(enabled, flag, current),
      anyEnabled: flag => flagEffective(enabled, flag, current) };
    installCapabilityActorSessionFlags(flags);
    expect(capabilityActorSessionsEnabled(ids.org)).toBe(true);
    expect(capabilityActorSessionsEnabled(ids.workspace)).toBe(false);
    expect(ROLLOUT_FLAGS.capability_actor_sessions.whileFeedUnavailable).toBe("off");
    current = false;
    expect(capabilityActorSessionsEnabled(ids.org)).toBe(false);
    current = true;
    enabled.delete("realtime_uplink");
    expect(capabilityActorSessionsEnabled(ids.org)).toBe(false);
  });
});
