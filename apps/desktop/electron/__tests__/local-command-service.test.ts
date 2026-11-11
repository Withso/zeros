import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalCommandDevice, LocalCommandMacResult, LocalCommandNotice, LocalCommandPendingNotice } from "@zeros/protocol/local-commands";
import { DeviceControlError, type DeviceEvent } from "../local-commands/control";
import { LocalCommandJournal } from "../local-commands/journal";
import { LocalCommandService, type LocalCommandServiceDeps } from "../local-commands/service";

const account = "55555555-5555-4555-8555-555555555555", deviceId = "7f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d11";
const device: LocalCommandDevice = { deviceId, registrationId: "8f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d12", instanceId: "9f1f6c1e-3b0a-4f7e-9d43-8a0b2b9c6d13", name: "Studio", capabilities: ["local-commands-v1"] };
const R1 = "a1111111-1111-4111-8111-111111111111", R2 = "a2222222-2222-4222-8222-222222222222";
const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

const notice = (requestId: string, extra: Partial<LocalCommandPendingNotice> = {}): LocalCommandPendingNotice => ({
  requestId, state: "pending", workspace: { id: "11111111-1111-4111-8111-111111111111", name: "w-7", title: "Fix login" }, chat: { id: "chat-1", title: "Simulator" },
  input: { command: "echo hi", cwd: "~/src" }, mac: "Studio", defaultMac: "Studio", isDefaultTarget: true,
  createdAt: new Date(Date.now()).toISOString(), approvalDeadline: new Date(Date.now() + 120_000).toISOString(), runDeadline: null, ...extra });

/** A scripted device channel: push events; the control records every call. */
function harness(options: { journalRoot?: string; alwaysAllow?: boolean; run?: LocalCommandServiceDeps["run"]; claim?: (requestId: string, decision: string) => Promise<LocalCommandNotice> } = {}) {
  const calls: string[] = [], results: Array<{ requestId: string; result: LocalCommandMacResult }> = [];
  const queue: Array<DeviceEvent | null> = [];
  const waiting: Array<(event: DeviceEvent | null) => void> = [];
  const push = (event: DeviceEvent | null) => { const next = waiting.shift(); if (next) next(event); else queue.push(event); };
  const events = async function* (_device: LocalCommandDevice, signal: AbortSignal): AsyncGenerator<DeviceEvent> {
    for (;;) {
      const event = queue.shift() ?? await new Promise<DeviceEvent | null>(resolve => { waiting.push(resolve); signal.addEventListener("abort", () => resolve(null), { once: true }); });
      if (!event || signal.aborted) return;
      yield event;
    }
  };
  let always = options.alwaysAllow ?? false;
  const published: Array<string[]> = [], notified: string[] = [];
  const running = new Map<string, AbortSignal>();
  const deps: LocalCommandServiceDeps = {
    control: {
      register: vi.fn(async () => { calls.push("register"); return { device, presence: { presenceRequired: false, reachableUntil: null }, heartbeatIntervalMs: 25000 as const }; }),
      unregister: vi.fn(async () => { calls.push("unregister"); }),
      heartbeat: vi.fn(async () => { calls.push("heartbeat"); return { presenceRequired: true, reachableUntil: null }; }),
      received: vi.fn(async (_device: LocalCommandDevice, requestId: string) => { calls.push(`received ${requestId}`); return notice(requestId); }),
      claim: vi.fn(async (_device: LocalCommandDevice, requestId: string, decision: "approve" | "deny") => {
        calls.push(`claim ${requestId} ${decision}`);
        return options.claim ? options.claim(requestId, decision) : decision === "approve" ? { ...notice(requestId), state: "claimed" as const } : { requestId, state: "terminal" as const, outcome: "denied" as const };
      }),
      get: vi.fn(async (_device: LocalCommandDevice, requestId: string) => { calls.push(`get ${requestId}`); return { requestId, state: "terminal" as const, outcome: "cancelled" as const }; }),
      result: vi.fn(async (_device: LocalCommandDevice, requestId: string, result: LocalCommandMacResult) => { calls.push(`result ${requestId} ${result.outcome}`); results.push({ requestId, result }); return { outcome: result.outcome }; }),
      ack: vi.fn(async (_device: LocalCommandDevice, requestId: string) => { calls.push(`ack ${requestId}`); }),
    },
    events,
    journal: async () => LocalCommandJournal.open(options.journalRoot!, account),
    run: options.run ?? (async (input, signal) => { running.set(input.command, signal); calls.push(`run ${input.command}`); return { outcome: "completed", code: 0, stdout: "hi\n", stderr: "", cwd: "/Users/alex/src" }; }),
    identity: { deviceId: () => deviceId, name: async () => "Studio" },
    settings: { alwaysAllow: () => always, setAlwaysAllow: value => { always = value; calls.push(`always ${value}`); } },
    session: async () => ({ accountId: account, sessionId: "s1" }),
    publish: approvals => { published.push(approvals.map(approval => approval.requestId)); },
    notify: approval => { notified.push(approval.requestId); },
    sleep: async () => {},
  };
  return { deps, calls, results, published, notified, running, push, alwaysAllowed: () => always };
}
async function setup(options: Parameters<typeof harness>[0] = {}) {
  const root = options.journalRoot ?? await mkdtemp(join(tmpdir(), "local-command-service-")); if (!options.journalRoot) directories.push(root);
  const h = harness({ ...options, journalRoot: root });
  const service = new LocalCommandService(h.deps);
  await service.start();
  await vi.waitFor(() => expect(h.calls).toContain("register"));
  return { ...h, service, root };
}
const until = (read: () => unknown) => vi.waitFor(() => expect(read()).toBeTruthy());

describe("local command service", () => {
  it("asks, journals before claiming, runs once after the claim, reports the result and acknowledges the terminal notice", async () => {
    const s = await setup();
    s.push({ event: "request", data: notice(R1) });
    await until(() => s.published.at(-1)?.includes(R1));
    expect(s.calls).toEqual(["register", `received ${R1}`]);
    expect(s.notified).toEqual([R1]);
    await s.service.decide(R1, "yes");
    await until(() => s.results.length === 1);
    expect(s.calls.slice(2)).toEqual([`claim ${R1} approve`, "run echo hi", `result ${R1} completed`]);
    expect(s.results[0]!.result).toEqual({ outcome: "completed", code: 0, stdout: "hi\n", stderr: "", cwd: "/Users/alex/src" });
    expect(s.published.at(-1)).toEqual([]);
    s.push({ event: "request", data: notice(R1) });
    s.push({ event: "request", data: { requestId: R1, state: "terminal", outcome: "completed" } });
    await until(() => s.calls.includes(`ack ${R1}`));
    expect(s.calls.filter(call => call.startsWith("run")).length).toBe(1);
    expect(s.calls.filter(call => call.startsWith("claim")).length).toBe(1);
    await s.service.stop();
  });

  it("refuses a decision for a request it never offered, a second decision, and one after the approval deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const s = await setup();
    await s.service.decide(R2, "yes");
    s.push({ event: "request", data: notice(R1) });
    await vi.waitFor(() => expect(s.published.at(-1)).toEqual([R1]));
    await s.service.decide(R1, "deny");
    await s.service.decide(R1, "yes");
    expect(s.calls.filter(call => call.startsWith("claim"))).toEqual([`claim ${R1} deny`]);
    s.push({ event: "request", data: notice(R2) });
    await vi.waitFor(() => expect(s.published.at(-1)).toEqual([R2]));
    await vi.advanceTimersByTimeAsync(121_000);
    expect(s.published.at(-1)).toEqual([]);
    await s.service.decide(R2, "yes");
    expect(s.calls.some(call => call.startsWith(`claim ${R2}`))).toBe(false);
    await s.service.stop();
  });

  it("ignores an approval made after the local approval deadline, even before its timer fires, and sends no claim", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const s = await setup();
    s.push({ event: "request", data: notice(R1) });
    await vi.waitFor(() => expect(s.published.at(-1)).toEqual([R1]));
    // The clock passes the deadline without the withdrawal timer running (a Mac waking from sleep).
    vi.setSystemTime(Date.now() + 121_000);
    await s.service.decide(R1, "yes");
    // decide queues its claim behind a journal write; give that real time.
    vi.useRealTimers(); await new Promise(resolve => setTimeout(resolve, 100));
    expect(s.published.at(-1)).toEqual([]);
    expect(s.calls.some(call => call.startsWith("claim") || call.startsWith("run"))).toBe(false);
    await s.service.stop();
  });

  it("never offers or auto-runs a request that arrives after its approval deadline", async () => {
    const s = await setup({ alwaysAllow: true });
    s.push({ event: "request", data: notice(R1, { approvalDeadline: new Date(Date.now() - 1_000).toISOString() }) });
    s.push({ event: "request", data: notice(R2, { isDefaultTarget: false, approvalDeadline: new Date(Date.now() - 1_000).toISOString() }) });
    await until(() => s.calls.includes(`received ${R2}`));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(s.calls.some(call => call.startsWith("claim") || call.startsWith("run"))).toBe(false);
    expect(s.notified).toEqual([]);
    expect(s.service.approvals()).toEqual([]);
    await s.service.stop();
  });

  it("runs without asking only for the chat's own target with Always allow on; an explicit Mac always asks", async () => {
    const s = await setup({ alwaysAllow: true });
    s.push({ event: "request", data: notice(R1) });
    await until(() => s.results.length === 1);
    expect(s.published.flat()).not.toContain(R1);
    s.push({ event: "request", data: notice(R2, { isDefaultTarget: false, input: { command: "ls", mac: "Studio" } }) });
    await until(() => s.published.at(-1)?.includes(R2));
    expect(s.calls.some(call => call.startsWith(`claim ${R2}`))).toBe(false);
    await s.service.stop();
  });

  it("turns on Always allow with Yes always", async () => {
    const s = await setup();
    s.push({ event: "request", data: notice(R1) });
    await until(() => s.published.at(-1)?.includes(R1));
    await s.service.decide(R1, "always");
    await until(() => s.results.length === 1);
    expect(s.alwaysAllowed()).toBe(true);
    await s.service.stop();
  });

  it("kills a running command when its notice turns terminal (Stop)", async () => {
    let release!: () => void;
    const s = await setup({ run: async (_input, signal) => new Promise(resolve => {
      release = () => resolve({ outcome: "cancelled" }); signal.addEventListener("abort", () => release(), { once: true }); }) });
    s.push({ event: "request", data: notice(R1) });
    await until(() => s.published.at(-1)?.includes(R1));
    await s.service.decide(R1, "yes");
    await until(() => s.calls.includes(`claim ${R1} approve`));
    s.push({ event: "request", data: { requestId: R1, state: "terminal", outcome: "cancelled" } });
    await until(() => s.calls.includes(`ack ${R1}`));
    await until(() => s.results.some(entry => entry.result.outcome === "cancelled"));
    await s.service.stop();
  });

  it("never runs a claim the server refused, and reconciles it by GET only", async () => {
    const s = await setup({ claim: async () => { throw new DeviceControlError(409, "local_command_not_pending"); } });
    s.push({ event: "request", data: notice(R1) });
    await until(() => s.published.at(-1)?.includes(R1));
    await s.service.decide(R1, "yes");
    await until(() => s.calls.includes(`get ${R1}`));
    expect(s.calls.some(call => call.startsWith("run"))).toBe(false);
    await s.service.stop();
  });

  it("reports interrupted after a restart for a request approved before it, and never runs it", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-command-service-")); directories.push(root);
    const journal = await LocalCommandJournal.open(root, account);
    await journal.begin(R1); await journal.mark(R1, "approved");
    const s = await setup({ journalRoot: root });
    await until(() => s.calls.includes(`result ${R1} interrupted`));
    s.push({ event: "request", data: { ...notice(R1), state: "claimed" } });
    s.push({ event: "request", data: { requestId: R1, state: "terminal", outcome: "interrupted" } });
    await until(() => s.calls.includes(`ack ${R1}`));
    expect(s.calls.some(call => call.startsWith("run") || call.startsWith(`claim ${R1}`))).toBe(false);
    await s.service.stop();
  });

  it("unregisters before sign-out, withdraws approvals and stops running work", async () => {
    let seen: AbortSignal | undefined;
    const s = await setup({ run: async (_input, signal) => { seen = signal; return new Promise(resolve => signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }), { once: true })); } });
    s.push({ event: "request", data: notice(R1) });
    s.push({ event: "request", data: notice(R2) });
    await until(() => s.published.at(-1)?.length === 2);
    await s.service.decide(R1, "yes");
    await until(() => seen);
    await s.service.beforeSignOut();
    expect(seen!.aborted).toBe(true);
    expect(s.calls).toContain("unregister");
    expect(s.published.at(-1)).toEqual([]);
    expect(s.service.deviceHeaders()).toBeNull();
  });

  it("hands a notify event to NotifyUser and nothing else: no journal, no received, no approval", async () => {
    const notified: unknown[] = [];
    const root = await mkdtemp(join(tmpdir(), "local-command-service-")); directories.push(root);
    const s = harness({ journalRoot: root });
    const service = new LocalCommandService({ ...s.deps, notifyUser: event => { notified.push(event); } });
    await service.start();
    await vi.waitFor(() => expect(s.calls).toContain("register"));
    const event = { notificationId: "0f0e0d0c-0b0a-4908-8706-050403020100", workspace: { id: "11111111-1111-4111-8111-111111111111", name: "w-7", title: "Fix login" },
      chat: { id: "chat-1", title: "Simulator" }, kind: "review" as const, title: "Ready for review", message: "Done.", createdAt: new Date().toISOString() };
    s.push({ event: "notify", data: event });
    await vi.waitFor(() => expect(notified).toEqual([event]));
    expect(s.calls).toEqual(["register"]);
    expect(service.approvals()).toEqual([]);
    await service.stop();
  });

  it("exposes this Mac's H values only while registered", async () => {
    const s = await setup();
    expect(s.service.deviceHeaders()).toEqual({ "X-Zeros-Device-Id": deviceId, "X-Zeros-Device-Registration": device.registrationId, "X-Zeros-Device-Instance": device.instanceId });
    await s.service.stop();
    expect(s.service.deviceHeaders()).toBeNull();
  });
});
