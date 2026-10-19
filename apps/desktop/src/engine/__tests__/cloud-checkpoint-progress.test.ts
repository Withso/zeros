import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCheckpointProgressSchema, type CloudCheckpointProgress } from "@zeros/protocol/cloud-checkpoint-progress";
import { CloudCheckpointProgressReporter } from "../cloud-checkpoint-progress";
import { CloudCommandRuntimeError } from "../cloud-command-client";

const reporters: CloudCheckpointProgressReporter[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] }));
afterEach(() => { for (const reporter of reporters.splice(0)) reporter.dispose(); vi.useRealTimers(); });
const settle = async () => { for (let turn = 0; turn < 5; turn++) await Promise.resolve(); };
function fixture(overrides: Partial<ConstructorParameters<typeof CloudCheckpointProgressReporter>[0]> = {}) {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
  const authority = { ...scope, heartbeatEndpoint: "https://control.test/internal/v1/cloud-workspaces/engine/heartbeat",
    heartbeatToken: `zwh_${"h".repeat(43)}` };
  const directive = { id: randomUUID(), reason: "before_stop" as const, deadlineAtMs: Date.now() + 60_000 };
  const posted: CloudCheckpointProgress[] = [];
  const requestFetch = vi.fn<typeof fetch>(async (_url, init) => {
    posted.push(CloudCheckpointProgressSchema.parse(JSON.parse(String(init?.body))));
    return new Response(null, { status: 202 });
  });
  const current = vi.fn(() => true), unsupported = vi.fn();
  const options = { authority, directive, registrationEndpoint: "https://control.test/internal/v1/cloud-workspaces/engine/register",
    requestFetch, current, unsupported, ...overrides };
  const reporter = new CloudCheckpointProgressReporter(options); reporters.push(reporter);
  return { reporter, scope, authority, directive, posted, requestFetch, current, unsupported, options };
}

describe("finite checkpoint diagnostics", () => {
  it.each(["construction", "publication", "flush"])("a throwing %s clock cannot change checkpoint execution", phase => {
    const f = phase === "construction" ? undefined : fixture();
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      if (phase !== "flush" || ++calls >= 3) throw new Error("private-clock-canary");
      return 0;
    });
    let reporter: CloudCheckpointProgressReporter | undefined;
    expect(() => { reporter = f?.reporter ?? fixture().reporter; reporter.stage("durability_capture"); reporter.fail(new Error()); }).not.toThrow();
    vi.restoreAllMocks(); reporter?.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("absorbs an accidentally rejecting current observer without admitting a report", async () => {
    const f = fixture({ current: (() => Promise.reject(new Error("private-observer-canary"))) as unknown as () => boolean });
    expect(() => f.reporter.stage("durability_capture")).not.toThrow();
    await settle();
    expect(f.requestFetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("absorbs an accidentally rejecting unsupported observer", async () => {
    const f = fixture({ unsupported: () => Promise.reject(new Error("private-observer-canary")) });
    f.requestFetch.mockResolvedValue(new Response(null, { status: 404 }));
    f.reporter.stage("durability_capture"); await settle();
    expect(f.requestFetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps only the first closed seal refusal and leaves the strict progress body unchanged", async () => {
    const f = fixture();
    const refusal = { version: 1, site: "request", code: "command_conflict", httpClass: "4xx" };
    f.reporter.sealRefusal(refusal); // No seal stage yet.
    f.reporter.stage("seal_ack");
    f.reporter.sealRefusal({ ...refusal, detail: "private-refusal-canary" });
    f.reporter.sealRefusal({ ...refusal, code: "private-code-canary" });
    f.reporter.sealRefusal(Object.defineProperty({}, "version", { get() { throw new Error("private-getter-canary"); } }));
    f.reporter.sealRefusal(refusal);
    f.reporter.sealRefusal({ ...refusal, code: "command_context_changed" });
    f.reporter.fail(new CloudCommandRuntimeError("command_conflict"));
    f.reporter.sealRefusal({ ...refusal, code: "command_service_unavailable", httpClass: "5xx" });
    await settle();
    const init = f.requestFetch.mock.calls.at(-1)![1]!;
    expect(new Headers(init.headers).get("x-zeros-checkpoint-seal-refusal")).toBe(JSON.stringify(refusal));
    expect(CloudCheckpointProgressSchema.parse(JSON.parse(String(init.body)))).not.toHaveProperty("sealRefusal");
    expect(JSON.stringify(f.requestFetch.mock.calls)).not.toContain("private-");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces held stage reports and aborts the obsolete observation before the first failure", async () => {
    const f = fixture(); let reply!: (response: Response) => void;
    f.requestFetch.mockImplementationOnce((_url, init) => {
      f.posted.push(JSON.parse(String(init?.body)));
      return new Promise(resolve => { reply = resolve; });
    });
    f.reporter.stage("checkpoint_received");
    const originalSignal = f.requestFetch.mock.calls[0]![1]!.signal!;
    f.reporter.stage("service_pause"); f.reporter.stage("setup_stop");
    expect(f.requestFetch).toHaveBeenCalledTimes(1);
    f.reporter.fail(new CloudCommandRuntimeError("command_storage_unavailable"));
    expect(originalSignal.aborted).toBe(true);
    expect(f.posted).toMatchObject([{ sequence: 1, state: "running" },
      { sequence: 4, stage: "setup_stop", state: "failed", reason: "storage" }]);
    f.reporter.fail(new Error("private-cleanup-canary")); f.reporter.stage("final_completion"); f.reporter.complete();
    reply(new Response("private-response-canary", { status: 404 })); await settle();
    expect(f.unsupported).not.toHaveBeenCalled();
    expect(f.posted).toHaveLength(2);
    expect(JSON.stringify(f.posted)).not.toContain("canary");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends only the latest pending stage after a slow observation, with no poll or retry", async () => {
    const f = fixture(); let reply!: (response: Response) => void;
    f.requestFetch.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    f.reporter.stage("checkpoint_received"); f.reporter.stage("service_pause"); f.reporter.stage("record_flush");
    reply(new Response(null, { status: 503 })); await settle();
    expect(f.requestFetch).toHaveBeenCalledTimes(2);
    expect(f.posted).toMatchObject([{ sequence: 3, stage: "record_flush" }]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.requestFetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a request to 64 observations and preserves a slot for its first failure", async () => {
    const f = fixture();
    for (let index = 0; index < 200; index++) {
      f.reporter.stage(index % 2 ? "setup_stop" : "record_flush"); await settle();
    }
    expect(f.posted).toHaveLength(63);
    f.reporter.fail(new Error("private-failure-canary")); await settle();
    expect(f.posted).toHaveLength(64);
    expect(f.posted.at(-1)).toMatchObject({ sequence: 64, state: "failed", reason: "unknown" });
    f.reporter.fail(new CloudCommandRuntimeError("checkpoint_pending_work")); f.reporter.complete(); await settle();
    expect(f.posted).toHaveLength(64); expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(f.posted)).not.toContain("private");
  });

  it.each([200, 5_000])("caps a held request at min(1 second, original %i ms remaining)", async remaining => {
    const f = fixture({ directive: { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + remaining } });
    f.requestFetch.mockImplementation(() => new Promise(() => {}));
    f.reporter.stage("setup_stop"); const signal = f.requestFetch.mock.calls[0]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(Math.min(1_000, remaining) - 1); expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(signal.aborted).toBe(true);
    f.reporter.stage("record_flush"); f.reporter.fail(new Error()); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.requestFetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("permanently fences the old observer across A-B-A authority changes", async () => {
    const f = fixture();
    f.reporter.stage("setup_stop"); await settle();
    f.current.mockReturnValue(false); f.reporter.stage("record_flush");
    f.current.mockReturnValue(true); f.reporter.stage("seal_ack");
    expect(f.requestFetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not extend the original monotonic deadline after a wall-clock correction", async () => {
    const f = fixture({ directive: { id: randomUUID(), reason: "before_stop", deadlineAtMs: Date.now() + 100 } });
    f.reporter.stage("setup_stop"); await settle();
    vi.setSystemTime(Date.now() - 60_000); await vi.advanceTimersByTimeAsync(100);
    f.reporter.stage("record_flush"); expect(f.requestFetch).toHaveBeenCalledTimes(1);
  });

  it("disables only optional diagnostics for an older CP's 404", async () => {
    const f = fixture(); f.requestFetch.mockResolvedValue(new Response(null, { status: 404 }));
    f.reporter.stage("checkpoint_received"); await settle();
    f.reporter.stage("setup_stop"); f.reporter.fail(new Error());
    expect(f.unsupported).toHaveBeenCalledTimes(1); expect(f.requestFetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 500])("does not retry or throw for diagnostic HTTP %i", async status => {
    const f = fixture(); f.requestFetch.mockResolvedValue(new Response("private-server-canary", { status }));
    expect(() => f.reporter.stage("setup_stop")).not.toThrow(); await settle();
    expect(f.unsupported).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.requestFetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["http://control.test/internal/v1/cloud-workspaces/engine/heartbeat",
    "https://foreign.test/internal/v1/cloud-workspaces/engine/heartbeat",
    "https://user:pass@control.test/internal/v1/cloud-workspaces/engine/heartbeat",
    "https://control.test/internal/v1/cloud-workspaces/engine/heartbeat?redirect=1",
    "https://control.test/foreign"])("refuses an invalid diagnostic origin or endpoint: %s", heartbeatEndpoint => {
    const f = fixture(); const reporter = new CloudCheckpointProgressReporter({ ...f.options,
      authority: { ...f.authority, heartbeatEndpoint } }); reporters.push(reporter);
    reporter.stage("checkpoint_received"); expect(f.requestFetch).not.toHaveBeenCalled();
  });

  it("fixes the same-origin route, disallows redirects and sends no bearer in the body", async () => {
    const f = fixture(); f.reporter.stage("setup_stop"); await settle();
    const [url, init] = f.requestFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://control.test/internal/v1/cloud-workspaces/engine/checkpoint-progress");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(f.posted[0]).toMatchObject({ ...f.scope, requestId: f.directive.id, state: "running", reason: "none" });
    expect(String(init?.body)).not.toContain(f.authority.heartbeatToken);
  });

  it.each([
    ["CloudCheckpointDeadlineError", undefined, "record_flush", "deadline"],
    ["Error", "cloud_containment_environment_not_ready", "terminal_drain", "native_custody"],
    ["CloudCommandRuntimeError", "engine_authority_rejected", "boot_quiesce", "authority_rejected"],
    ["CloudCommandRuntimeError", "command_conflict", "command_drain", "pending_work"],
    ["CloudCommandRuntimeError", "checkpoint_pending_work", "seal_create", "pending_work"],
    ["Error", undefined, "mirror_flush", "mirror"],
  ] as const)("reduces %s/%s at %s to %s", (name, code, stage, reason) => {
    const f = fixture(); f.reporter.stage(stage);
    f.reporter.fail(Object.assign(new Error("private-native-path-canary"), { name, code }));
    expect(f.posted.at(-1)).toMatchObject({ state: "failed", stage, reason });
    expect(JSON.stringify(f.posted)).not.toContain("canary");
  });
});
