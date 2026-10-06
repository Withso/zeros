import { describe, expect, it, vi } from "vitest";
import { CloudUserPresence, CloudIdleStopScheduler } from "../cloud-idle-stop";
import type { TransportClient } from "../transport/types";
import type { CloudDurabilityAuthority } from "../cloud-durability-runtime";

function client(id: string, deviceId = id): TransportClient {
  return { id, kind: "cloud", accountUserId: "account", cloudActor: {
    sessionId: id, deviceId, role: "viewer", fingerprint: "a".repeat(64),
  }, authorized: () => true, send: vi.fn(), close: vi.fn() };
}

describe("admitted cloud user presence", () => {
  it("keeps two devices active until the last one leaves, then waits ten quiet minutes", async () => {
    let now = 0;
    const stop = vi.fn(async () => true);
    const presence = new CloudUserPresence({ now: () => now, activity: () => scheduler.activity() });
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => presence.active(), stop });
    const first = client("first"), second = client("second"), authority = {} as CloudDurabilityAuthority;
    presence.update(first, { present: true });
    presence.update(second, { present: true });
    presence.release(first);
    for (let i = 0; i < 20; i++) {
      now += 60_000; presence.update(second, { present: true }); scheduler.consider(authority);
    }
    expect(stop).not.toHaveBeenCalled();
    presence.update(second, { present: false }); scheduler.consider(authority);
    now += 599_999; scheduler.consider(authority); expect(stop).not.toHaveBeenCalled();
    now++; scheduler.consider(authority); await scheduler.settled(); expect(stop).toHaveBeenCalledOnce();
  });

  it("expires a disconnected or sleeping device using server time and live admission", () => {
    let now = 0;
    const presence = new CloudUserPresence({ now: () => now, activity: vi.fn() });
    const device = client("device");
    expect(presence.update(device, { present: true })).toBe(true);
    now = 90_000; expect(presence.active()).toBe(false);
    presence.update(device, { present: true }); expect(presence.active()).toBe(true);
    device.authorized = () => false; expect(presence.active()).toBe(false);
  });

  it("rate limits flapping and reconnects for one device without extending its lease", () => {
    let now = 0;
    const activity = vi.fn(), presence = new CloudUserPresence({ now: () => now, activity });
    const first = client("first", "device"), reconnect = client("second", "device");
    presence.update(first, { present: true });
    for (let i = 0; i < 100; i++) {
      now++; presence.update(first, { present: false }); presence.update(reconnect, { present: true });
    }
    expect(activity).toHaveBeenCalledOnce();
    now = 90_000; expect(presence.active()).toBe(false);
  });

  it("rejects unadmitted, local, revoked and timestamp-bearing signals", () => {
    const presence = new CloudUserPresence({ activity: vi.fn() });
    expect(presence.update({ ...client("probe"), cloudActor: undefined }, { present: true })).toBe(false);
    expect(presence.update({ ...client("local"), kind: "local" }, { present: true })).toBe(false);
    expect(presence.update({ ...client("unbound"), accountUserId: undefined }, { present: true })).toBe(false);
    expect(presence.update({ ...client("revoked"), authorized: () => false }, { present: true })).toBe(false);
    expect(presence.update(client("future"), { present: true, at: Number.MAX_SAFE_INTEGER })).toBe(false);
    expect(presence.active()).toBe(false);
  });

  it("invalidates a pending stop immediately when presence returns", async () => {
    let now = 0, finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const commit = vi.fn();
    const presence = new CloudUserPresence({ now: () => now, activity: () => scheduler.activity() });
    const scheduler = new CloudIdleStopScheduler({ now: () => now, busy: () => presence.active(),
      stop: async (_authority, stillIdle) => { await gate; if (stillIdle()) commit(); } });
    now = 600_000; scheduler.consider({} as CloudDurabilityAuthority);
    await Promise.resolve(); presence.update(client("returning"), { present: true }); finish();
    await scheduler.settled(); expect(commit).not.toHaveBeenCalled();
  });
  it("distinguishes absent presence from missing or expired reports without changing idle behavior", () => {
    let now=0;
    const activity=vi.fn(),presence=new CloudUserPresence({now:()=>now,activity});
    const first=client("first"),second=client("second");
    expect(presence.snapshot([])).toBe("absent");
    expect(presence.snapshot([first])).toBe("unknown");
    presence.update(first,{present:false});
    expect(presence.snapshot([first])).toBe("absent");
    expect(activity).not.toHaveBeenCalled();
    presence.update(second,{present:true});
    expect(presence.snapshot([first,second])).toBe("present");
    now=90_000;
    expect(presence.snapshot([first,second])).toBe("unknown");
    expect(presence.active()).toBe(false);
    presence.update(first,{present:false});
    presence.release(second);
    expect(presence.snapshot([first])).toBe("absent");
  });

});
