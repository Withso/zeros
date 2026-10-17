import { describe, expect, it } from "vitest";
import { CapabilitySigningKeyStore } from "../cloud-workspaces/capability-keys.js";
import { ROLLOUT_FLAGS_OFF, type RolloutFlagSnapshot } from "../rollout-flags.js";
import {
  UPLINK_AUTH_SYNC_MAX_BYTES,
  UplinkSnapshotTooLargeError,
  assertUplinkSnapshotSize,
  uplinkCapabilityAuthority,
} from "./uplink-auth-source.js";
import type { UplinkAuthSnapshot } from "./uplink-protocol.js";

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

/** S2 control frames are 64 KiB; the snapshot guard refuses an oversize
 * frame before it is ever written (review SHOULD-2). */
describe("auth.sync size guard", () => {
  const snapshot = (padding: number): UplinkAuthSnapshot => ({
    epochs: { wa: 1, wr: 1, members: { ["u".padEnd(padding, "u")]: 1 } },
    revocations: [], authCursor: "t1", complete: true,
  });

  it("accepts a snapshot at the byte bound and refuses one byte over", () => {
    const exact = JSON.stringify(snapshot(10));
    const fitted = snapshot(10 + UPLINK_AUTH_SYNC_MAX_BYTES - Buffer.byteLength(exact, "utf8"));
    expect(() => assertUplinkSnapshotSize(fitted, UPLINK_AUTH_SYNC_MAX_BYTES)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBe(UPLINK_AUTH_SYNC_MAX_BYTES);
    const over = snapshot(11 + UPLINK_AUTH_SYNC_MAX_BYTES - Buffer.byteLength(exact, "utf8"));
    expect(() => assertUplinkSnapshotSize(over, UPLINK_AUTH_SYNC_MAX_BYTES)).toThrow(UplinkSnapshotTooLargeError);
  });

  it("bounds the default below the 64 KiB control frame", () => {
    expect(UPLINK_AUTH_SYNC_MAX_BYTES).toBeLessThan(64 * 1024);
  });
});
