import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalCommandDevice } from "@zeros/protocol/local-commands";
import { DeviceControlError, type DeviceEvent } from "../local-commands/control";
import { LocalCommandJournal } from "../local-commands/journal";
import { LocalCommandService, type LocalCommandServiceDeps } from "../local-commands/service";

const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const account = "55555555-5555-4555-8555-555555555555", deviceId = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const device: LocalCommandDevice = { deviceId, registrationId: "8f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d12", instanceId: "9f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d13", name: "Studio", capabilities: ["local-commands-v1"] };
const ready = (presenceRequired: boolean): DeviceEvent => ({ event: "ready", data: { deviceId, registrationId: device.registrationId, instanceId: device.instanceId,
  presence: { presenceRequired, reachableUntil: null }, heartbeatIntervalMs: 25_000 } });

type Stream = Array<DeviceEvent | "end" | "hang" | Error | Promise<void>>;
/** Each events() call plays the next scripted stream: events, then end, an error, or silence (a half-dead socket). */
async function fixture(streams: Stream[], options: { register?: Array<Error | null>; presenceRequired?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "local-command-channel-")); directories.push(root);
  let session: { accountId: string; sessionId: string } | null = { accountId: account, sessionId: "s1" };
  const calls: string[] = [], logs: string[] = [];
  const registers = [...(options.register ?? [])];
  const deps: LocalCommandServiceDeps = {
    control: {
      register: vi.fn(async () => { calls.push("register"); const failure = registers.shift(); if (failure) throw failure;
        return { device, presence: { presenceRequired: options.presenceRequired ?? false, reachableUntil: null }, heartbeatIntervalMs: 25000 as const }; }),
      unregister: vi.fn(async () => {}), heartbeat: vi.fn(async () => { calls.push("heartbeat"); return { presenceRequired: true, reachableUntil: null }; }),
      received: vi.fn(), claim: vi.fn(), get: vi.fn(), result: vi.fn(), ack: vi.fn(),
    } as unknown as LocalCommandServiceDeps["control"],
    events: async function* (_device, signal) {
      calls.push("events");
      const script = streams.shift() ?? ["hang"];
      for (const step of script) {
        if (step === "end") return;
        if (step instanceof Error) throw step;
        // Waiting is abortable, as a real fetch read is.
        if (step instanceof Promise) { await Promise.race([step, new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]); continue; }
        if (step === "hang") { await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); return; }
        yield step;
      }
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
    journal: async () => LocalCommandJournal.open(root, account),
    run: vi.fn(), identity: { deviceId: () => deviceId, name: async () => "Studio" },
    settings: { alwaysAllow: () => false, setAlwaysAllow: () => {} },
    session: async () => session, publish: () => {}, notify: () => {},
    sleep: async () => {}, log: line => { logs.push(line); },
  };
  const service = new LocalCommandService(deps);
  return { service, calls, logs, setSession: (next: typeof session) => { session = next; } };
}
const revoked: DeviceEvent = { event: "revoked", data: { code: "session_revoked" } };

describe("the local command channel survives token expiry", () => {
  it("reconnects after the stream says session_revoked while the same session is signed in (an expired token, not a sign-out)", async () => {
    const f = await fixture([[ready(false), revoked], [ready(false), "hang"]]);
    await f.service.start();
    await vi.waitFor(() => expect(f.calls.filter(call => call === "events")).toHaveLength(2));
    expect(f.calls.filter(call => call === "register")).toHaveLength(1);
    await f.service.stop();
  });

  it("reconnects after a 401 from the stream or from registration with the same session, and stops once the session is gone or changed", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture([[ready(false), new DeviceControlError(401, "unauthorized")], [ready(false), gate, revoked]],
      { register: [new DeviceControlError(401, "unauthorized"), null] });
    await f.service.start();
    await vi.waitFor(() => expect(f.calls.filter(call => call === "events")).toHaveLength(2));
    expect(f.calls.filter(call => call === "register")).toHaveLength(2);
    // Another session signs in, then the old stream is revoked: stop (install.ts restarts the service for it).
    f.setSession({ accountId: account, sessionId: "s2" });
    release();
    await vi.waitFor(() => expect(f.logs).toContain("channel stopped reason=signed_out"));
    expect(f.calls.filter(call => call === "events")).toHaveLength(2);
    await f.service.stop();
  });

  it("aborts a stream silent for 70 s (a half-dead socket after sleep) and reconnects, beating at once when presence is required", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const f = await fixture([[ready(true), "hang"], [ready(true), "hang"]], { presenceRequired: true });
    await f.service.start();
    await vi.waitFor(() => expect(f.calls).toContain("events"));
    // On the first stream's ready, presence is required: a heartbeat goes at once, not after 25 s.
    await vi.waitFor(() => expect(f.calls.filter(call => call === "heartbeat")).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(69_000);
    expect(f.calls.filter(call => call === "events")).toHaveLength(1);
    const beats = f.calls.filter(call => call === "heartbeat").length;   // the first plus the 25 s and 50 s ticks
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(f.calls.filter(call => call === "events")).toHaveLength(2));
    // The reconnect at 70 s beats at once, before the 75 s tick.
    await vi.waitFor(() => expect(f.calls.filter(call => call === "heartbeat").length).toBe(beats + 1));
    await f.service.stop();
  });

  it("beats at once when presence flips to required, not 25 s later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const f = await fixture([[ready(false), { event: "presence", data: { presenceRequired: true, reachableUntil: null } }, "hang"]]);
    await f.service.start();
    await vi.waitFor(() => expect(f.calls).toContain("heartbeat"));
    await f.service.stop();
  });

  it("reconnects at once after a clean end of a healthy stream (the server ends it before the token expires), and backs off a stream that ends at once", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sleeps: number[] = [];
    const f = await fixture([[ready(false), "end"], [ready(false), "end"], [ready(false), "hang"]]);
    (f.service as unknown as { deps: { sleep(ms: number): Promise<void> } }).deps.sleep = async ms => { sleeps.push(ms); now += ms; };
    const events = (f.service as unknown as { deps: LocalCommandServiceDeps }).deps.events;
    let calls = 0;
    (f.service as unknown as { deps: LocalCommandServiceDeps }).deps.events = (device, signal) => { if (calls++ === 0) now += 240_000; return events(device, signal); };
    await f.service.start();
    await vi.waitFor(() => expect(f.calls.filter(call => call === "events")).toHaveLength(3));
    // 240 s healthy, then a clean end: no delay. The second stream ended at once: backoff.
    expect(sleeps).toEqual([0, 1000]);
    await f.service.stop();
    vi.restoreAllMocks();
  });

  it("heartbeats only while a stream is open and has delivered ready: none after it ends, again after the next ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let release!: () => void, reopen!: () => void;
    const ended = new Promise<void>(resolve => { release = resolve; }), readyAgain = new Promise<void>(resolve => { reopen = resolve; });
    const f = await fixture([[ready(true), ended, "end"], [readyAgain, ready(true), "hang"]], { presenceRequired: true });
    await f.service.start();
    const beats = () => f.calls.filter(call => call === "heartbeat").length;
    await vi.advanceTimersByTimeAsync(10);
    expect(f.calls).toEqual(["register", "events", "heartbeat"]);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(beats()).toBe(3);
    release();                                   // the stream ends; the next one is open but has not said ready
    await vi.advanceTimersByTimeAsync(10);
    expect(f.calls.filter(call => call === "events")).toHaveLength(2);
    // Under the 70 s silence watchdog: the stream stays open, it just has not said ready.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(beats()).toBe(3);
    reopen();
    await vi.advanceTimersByTimeAsync(10);
    expect(beats()).toBe(4);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(beats()).toBe(5);
    await f.service.stop();
  });

  it("logs each state change with closed codes only", async () => {
    const f = await fixture([[ready(false), revoked], [ready(false), "hang"]]);
    await f.service.start();
    await vi.waitFor(() => expect(f.calls.filter(call => call === "events")).toHaveLength(2));
    await f.service.stop();
    expect(f.logs.some(line => /^registered/.test(line))).toBe(true);
    expect(f.logs.some(line => /^channel open/.test(line))).toBe(true);
    expect(f.logs.some(line => /^channel closed reason=session_revoked open_s=\d+/.test(line))).toBe(true);
    expect(f.logs.some(line => /^reconnect scheduled attempt=\d+ delay_ms=\d+/.test(line))).toBe(true);
    expect(f.logs.join("\n")).not.toMatch(/Studio|synthetic|token/i);
  });
});
