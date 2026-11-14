import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 0 }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "synthetic-session", user: { sub: "u" } }) }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation }));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); } } }));
vi.mock("../../features/update/control-plane-fetch", () => ({ controlPlaneFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
import { ControlPlaneError } from "../../features/team/control-plane";
import { readCloudWorkspaceEvents, watchCloudWorkspaceEvents, type CloudWorkspaceEvent } from "../cloud-workspace-events";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const alex = "44444444-4444-4444-8444-444444444444", sam = "55555555-5555-4555-8555-555555555555";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); state.generation = 0; });

describe("the workspace events stream", () => {
  it("asks with the opt-in header and parses events split across chunks, ignoring comments, unknown events and bad data", async () => {
    const chunks = [": hello\n\nevent: ready\ndata: {\"teamSharing\":1}\n\nevent: pres", "ence\r\ndata: {\"workspaceId\":\"x\",\"userIds\":[\"" + alex + "\"],\"total\":1}\r\n\r\n",
      "event: future\ndata: {}\n\nevent: presence\ndata: {\"userIds\":\"nope\"}\n\nevent: heartbeat\ndata: {}\n\nevent: changed\ndata: {\"workspaceId\":\"x\"}\n\nevent: revoked\ndata: {\"code\":\"workspace_access_changed\"}\n\n"];
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    } })));
    vi.stubGlobal("fetch", fetchMock);
    const seen: CloudWorkspaceEvent[] = [];
    for await (const event of readCloudWorkspaceEvents(target, new AbortController().signal)) seen.push(event);
    expect(seen).toEqual([{ event: "ready" }, { event: "presence", userIds: [alex], total: 1 }, { event: "heartbeat" }, { event: "changed" },
      { event: "revoked", code: "workspace_access_changed" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.example.test/v1/cloud-v2/workspaces/${target.workspaceId}/events`);
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("x-zeros-team-sharing")).toBe("1");
  });

  it("throws the status of a refused stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const stream = readCloudWorkspaceEvents(target, new AbortController().signal);
    await expect(stream.next()).rejects.toMatchObject({ status: 404 });
  });
});

type Step = CloudWorkspaceEvent | "end" | "hang" | Error;
function harness(scripts: Step[][]) {
  let now = 0;
  const opens: number[] = [], sleeps: number[] = [];
  const handlers = { invalidate: vi.fn(), presence: vi.fn(), ended: vi.fn() };
  const events = async function* (_target: unknown, signal: AbortSignal): AsyncGenerator<CloudWorkspaceEvent> {
    opens.push(now);
    for (const step of scripts.shift() ?? ["hang"]) {
      if (step === "end") return;
      if (step instanceof Error) throw step;
      if (step === "hang") { await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); return; }
      yield step;
    }
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  const stop = watchCloudWorkspaceEvents(target, handlers, { events: events as never, now: () => now, sleep: async ms => { sleeps.push(ms); } });
  return { handlers, opens, sleeps, stop, advance: (ms: number) => { now += ms; } };
}

describe("watching a teammate's workspace", () => {
  it("reads again on ready and changed, never on heartbeat, and reports presence only when the people change", async () => {
    const h = harness([[{ event: "ready" }, { event: "heartbeat" }, { event: "presence", userIds: [alex, sam], total: 2 }, { event: "heartbeat" },
      { event: "presence", userIds: [sam, alex], total: 2 }, { event: "changed" }, { event: "presence", userIds: [alex], total: 1 }, "hang"]]);
    await vi.waitFor(() => expect(h.handlers.presence).toHaveBeenCalledTimes(2));
    expect(h.handlers.invalidate).toHaveBeenCalledTimes(2);
    expect(h.handlers.presence.mock.calls).toEqual([[[alex, sam], 2], [[alex], 1]]);
    h.stop();
  });

  it("stops for good on revoked or a 404, without reconnecting", async () => {
    const revoked = harness([[{ event: "ready" }, { event: "revoked", code: "workspace_access_changed" }]]);
    await vi.waitFor(() => expect(revoked.handlers.ended).toHaveBeenCalledWith("workspace_access_changed"));
    const gone = harness([[new ControlPlaneError(404, "not_found", "gone")]]);
    await vi.waitFor(() => expect(gone.handlers.ended).toHaveBeenCalledWith("not_found"));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect([revoked.opens.length, gone.opens.length]).toEqual([1, 1]);
  });

  it("reconnects at once after a healthy stream's clean end, and backs off one that ends at once or fails", async () => {
    const h = harness([[{ event: "ready" }, "end"], [{ event: "ready" }, "end"], [new Error("network")], [{ event: "ready" }, "hang"]]);
    // The first stream lives 40 s before the server ends it (its token's end).
    h.advance(40_000);
    await vi.waitFor(() => expect(h.opens).toHaveLength(4));
    expect(h.sleeps).toEqual([1000, 2000]);
    h.stop();
  });

  it("aborts a stream silent for 70 s and reopens it at once; heartbeats keep it open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness([[{ event: "ready" }, "hang"], [{ event: "ready" }, "hang"]]);
    await vi.advanceTimersByTimeAsync(69_000);
    expect(h.opens).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.opens).toHaveLength(2);
    expect(h.sleeps).toEqual([]);
    h.stop();
  });

  it("stops when the account changes", async () => {
    const h = harness([[{ event: "ready" }, "end"], [{ event: "ready" }, "hang"]]);
    state.generation = 1;
    h.advance(40_000);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.opens).toHaveLength(1);
    h.stop();
  });
});

describe("a waking workspace's events stream", () => {
  it("opens no stream while the workspace is not ready, and opens once when it becomes ready", async () => {
    let ready = false;
    const listeners = new Set<() => void>();
    const opens: number[] = [];
    const events = async function* (_target: unknown, signal: AbortSignal): AsyncGenerator<CloudWorkspaceEvent> {
      opens.push(1);
      yield { event: "ready" };
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    };
    const stop = watchCloudWorkspaceEvents(target, { invalidate: vi.fn(), presence: vi.fn(), ended: vi.fn() }, {
      events: events as never, sleep: async () => {},
      ready: () => ready, onReadiness: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    });
    for (let i = 0; i < 5; i++) { for (const listener of [...listeners]) listener(); await Promise.resolve(); }
    expect(opens).toHaveLength(0);
    ready = true;
    for (const listener of [...listeners]) listener();
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    stop();
    expect(listeners.size).toBe(0);
  });
});

