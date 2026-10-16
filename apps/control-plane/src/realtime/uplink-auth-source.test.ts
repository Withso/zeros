import { describe, expect, it } from "vitest";
import { CapabilitySigningKeyStore } from "../cloud-workspaces/capability-keys.js";
import { ROLLOUT_FLAGS_OFF, type RolloutFlagSnapshot } from "../rollout-flags.js";
import { uplinkCapabilityAuthority } from "./uplink-auth-source.js";

const store = {} as CapabilitySigningKeyStore;

/** Only the `anyEnabled` gate matters here; the snapshot is a class, so the
 * test supplies the narrowest structural stub. */
function flags(any: boolean): RolloutFlagSnapshot {
  return { anyEnabled: (flag: string) => any && flag === "capabilities", enabled: () => any } as unknown as RolloutFlagSnapshot;
}

describe("uplinkCapabilityAuthority mount gate", () => {
  it("stays unmounted without keys, an issuer or the flag", () => {
    const pool = {} as never;
    expect(uplinkCapabilityAuthority({ pool, keyStore: null, issuer: "https://cp.example.test", flags: flags(true) })).toBeNull();
    expect(uplinkCapabilityAuthority({ pool, keyStore: store, issuer: null, flags: flags(true) })).toBeNull();
    expect(uplinkCapabilityAuthority({ pool, keyStore: store, issuer: "https://cp.example.test", flags: null })).toBeNull();
    expect(uplinkCapabilityAuthority({ pool, keyStore: store, issuer: "https://cp.example.test", flags: flags(false) })).toBeNull();
  });

  it("mounts once keys, issuer and the capabilities flag are all present", () => {
    const mounted = uplinkCapabilityAuthority({
      pool: {} as never, keyStore: store, issuer: "https://cp.example.test", flags: flags(true),
    });
    expect(mounted).not.toBeNull();
    expect(typeof mounted!.source.keys).toBe("function");
    expect(typeof mounted!.issuer.issue).toBe("function");
  });

  it("never consults the all-off reader", () => {
    expect(uplinkCapabilityAuthority({
      pool: {} as never, keyStore: store, issuer: "https://cp.example.test",
      flags: ROLLOUT_FLAGS_OFF as unknown as RolloutFlagSnapshot,
    })).toBeNull();
  });
});
