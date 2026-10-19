import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdkFixture, type SdkFixtureOptions } from "./zeros-dev-sdk-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(options: SdkFixtureOptions = {}) {
  const f = await sdkFixture(options); cleanups.push(f.close); return f;
}

describe("headless native SDK canary", () => {
  it("loads under the real Node/tsx harness without renderer or Vite globals", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      'await import("./scripts/zeros-dev/sdk-canary.ts"); await import("./scripts/zeros-dev/hourly-main.ts"); process.stdout.write("native-sdk-loaded");'],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("native-sdk-loaded");
  });

  it.each([false, true])("uses native admission, signed direct auth and exact boot readiness (accepted-work metadata %s)", async acceptedWork => {
    const f = await fixture({ acceptedWork }); await f.probe();
    expect(f.proofs).toEqual([{ action: "device-session.create", valid: true }, { action: "runtime.connect", valid: true }, { action: "capability", valid: true }]);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.urls).toEqual([f.streamUrl, f.directUrl]);
    expect(f.seen.find(row => row.type === "CONNECTED")).not.toHaveProperty("authToken");
    expect(f.seen.filter(row => row.type === "WORKSPACE_REQUEST").every(row => row.op === "workspace.list")).toBe(true);
    expect(f.output.map(row => [row.phase, row.outcome])).toEqual([
      ["sdk_device_session", "ok"], ["sdk_device_stream_ready", "ok"], ["sdk_runtime_connect", "ok"], ["sdk_runtime_ready", "ok"],
    ]);
    expect(new Set(f.output.map(row => row.sdk.probeId)).size).toBe(1);
    expect(f.output.every(row => Number.isFinite(row.durationMs) && row.durationMs > 0)).toBe(true);
    expect(f.output.at(-1).sdk).toMatchObject({ route: "direct" });
    expect(f.output[1].sdk).toMatchObject({ organizationCoverage: "enabled" });
    await vi.waitFor(() => expect(f.clientPeers.every(peer => peer.readyState === 3)).toBe(true));
    const serialized = JSON.stringify(f.output);
    for (const secret of [f.credential.privateKey, f.capabilities.engine.token, f.capabilities.realtime.token, f.ticket,
      f.directUrl, f.streamUrl, "fixture-private-bearer", "private-cursor"])
      expect(serialized).not.toContain(secret);
  });

  it.each([false, true])("skips dependencies cleanly when device_stream is off (runtime_connect %s)", async runtimeConnect => {
    const f = await fixture({ deviceStream: false, runtimeConnect }); await f.probe();
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.urls).toEqual([]);
    expect(f.output).toHaveLength(4);
    expect(f.output.every(row => row.outcome === "skipped")).toBe(true);
    expect(f.output[0].sdk.skip).toBe("legacy_discovery");
    expect(f.output.slice(1).every(row => row.sdk.skip === "session_unavailable")).toBe(true);
  });

  it("proves device_stream independently while runtime_connect remains off", async () => {
    const f = await fixture({ runtimeConnect: false }); await f.probe();
    expect(f.output.map(row => row.outcome)).toEqual(["ok", "ok", "skipped", "skipped"]);
    expect(f.output[2].sdk.skip).toBe("legacy_discovery"); expect(f.output[3].sdk.skip).toBe("runtime_legacy");
    expect(f.urls).toEqual([f.streamUrl]);
  });

  it("uses a later advertised realtime origin unchanged", async () => {
    const f = await fixture(), advertised = "wss://realtime-alpha.zeros.build/v1/device-stream";
    f.sessionResponse.stream.url = advertised; await f.probe();
    expect(f.urls).toEqual([advertised, f.directUrl]);
  });

  it("does not reuse a prior negative discovery across fixture connections", async () => {
    const f = await fixture({ runtimeConnect: false }); await f.probe();
    f.fetcher.mockImplementation(async url => Response.json(String(url).endsWith("/device-sessions") ? f.sessionResponse : f.connection, { status: 201 }));
    await f.probe();
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_ready", outcome: "ok" });
    expect(f.output[0].sdk.probeId).not.toBe(f.output[4].sdk.probeId);
  });

  it("records an old runtime binding as legacy instead of claiming a direct SDK handshake", async () => {
    const f = await fixture({ omitBinding: true }); await f.probe();
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_ready", outcome: "skipped", sdk: { skip: "runtime_legacy" } });
    expect(f.urls).toEqual([f.streamUrl]);
  });

  it.each([
    [401, "unauthorized", "auth_denied"], [403, "forbidden", "forbidden"], [404, "cloud_workspace_not_found", "not_found"],
    [429, "rate_limited", "rate_limited"], [503, "server_unavailable", "service_unavailable"],
  ])("fails, rather than skips, device session error %s/%s", async (status, code, expected) => {
    const f = await fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ error: { code, message: "synthetic-private-error" } }, { status: Number(status) }));
    await expect(f.probe()).rejects.toMatchObject({ code: expected });
    expect(f.output).toEqual([expect.objectContaining({ phase: "sdk_device_session", outcome: "failed", code: expected })]);
    expect(JSON.stringify(f.output)).not.toContain("synthetic-private-error");
  });

  it.each([401, 403, 404, 503])("does not hide runtime admission error %s as disabled", async status => {
    const f = await fixture(), fetcher = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).endsWith("/runtime/connect")
      ? Response.json({ error: { code: "specific_denial", message: "private-body" } }, { status }) : fetcher(url, init));
    await expect(f.probe()).rejects.toHaveProperty("code");
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_connect", outcome: "failed" });
    expect(f.output.some(row => row.outcome === "skipped")).toBe(false);
  });

  it.each(["missing", "foreign"] as const)("refuses %s organization proof even when a stream is open", async streamMetadata => {
    const f = await fixture({ streamMetadata }); await expect(f.probe()).rejects.toMatchObject({ code: "bad_response" });
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_device_stream_ready", outcome: "failed" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([{ streamClose: 4404 }, { streamMetadata: "disabled" as const }])("skips explicitly disabled stream coverage without attributing another org", async options => {
    const f = await fixture(options); await f.probe();
    expect(f.output[1]).toMatchObject({ phase: "sdk_device_stream_ready", outcome: "skipped" });
    expect(f.output[1].sdk).not.toHaveProperty("organizationCoverage");
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_ready", outcome: "ok" });
  });

  it.each([{ wrongSession: true }, { malformedReady: true }, { streamClose: 4401 }, { streamClose: 1011 }])("refuses invalid or failed native stream readiness %#", async options => {
    const f = await fixture(options); await expect(f.probe()).rejects.toHaveProperty("code");
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_device_stream_ready", outcome: "failed" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([{ org: randomUUID() }, { wsp: randomUUID() }, { gen: 8 }, { did: randomUUID() }])("retains the native capability scope fence %#", async claims => {
    const f = await fixture({ claims }); await expect(f.probe()).rejects.toMatchObject({ code: "bad_response" });
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_connect", outcome: "failed" });
    expect(f.urls).toEqual([f.streamUrl]);
  });

  it("rejects a relay winner as direct proof", async () => {
    const f = await fixture({ route: "relay" }); await expect(f.probe()).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_ready", outcome: "failed" });
    expect(f.output.at(-1).sdk).not.toHaveProperty("route");
  });

  it("fences an ENGINE_READY from a different boot", async () => {
    const f = await fixture({ wrongBoot: true }); await expect(f.probe()).rejects.toHaveProperty("code");
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_ready", outcome: "failed" });
    expect(f.proofs.at(-1)).toEqual({ action: "capability", valid: true });
  });

  it("requires ENGINE_READY after auth.ok and closes all sockets on cancellation", async () => {
    const f = await fixture({ omitReady: true }), pending = f.probe();
    const rejected = expect(pending).rejects.toMatchObject({ code: "deadline" });
    await vi.waitFor(() => expect(f.proofs.some(row => row.action === "capability")).toBe(true));
    expect(f.output.some(row => row.phase === "sdk_runtime_ready")).toBe(false);
    f.controller.abort(); await rejected;
    await vi.waitFor(() => expect(f.clientPeers.every(peer => peer.readyState === 3)).toBe(true));
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_ready", outcome: "failed", code: "deadline" });
  });

  it.each(["account", "device", "abort"] as const)("fences a late device-session response after %s change", async change => {
    const f = await fixture(); let finish!: (value: Response) => void;
    f.fetcher.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const pending = f.probe(); const rejected = expect(pending).rejects.toHaveProperty("code");
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    if (change === "account") f.changeAccount(); else if (change === "device") f.changeDevice(); else f.controller.abort();
    finish(Response.json(f.sessionResponse, { status: 201 })); await rejected;
    expect(f.urls).toEqual([]); expect(f.output.some(row => row.outcome === "ok")).toBe(false);
  });

  it.each(["account", "device", "abort"] as const)("fences a late runtime admission after %s change", async change => {
    const f = await fixture(), fetcher = f.fetcher.getMockImplementation()!;
    let finish!: (value: Response) => void;
    f.fetcher.mockImplementation((url, init) => String(url).endsWith("/runtime/connect")
      ? new Promise<Response>(resolve => { finish = resolve; }) : fetcher(url, init));
    const pending = f.probe(), rejected = expect(pending).rejects.toHaveProperty("code");
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    if (change === "account") f.changeAccount(); else if (change === "device") f.changeDevice(); else f.controller.abort();
    finish(Response.json(f.connection, { status: 201 })); await rejected;
    expect(f.urls).toEqual([f.streamUrl]);
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_connect", outcome: "failed" });
  });

  it.each(["account", "device"] as const)("rechecks %s after the final workspace read before publishing readiness", async change => {
    const f = await fixture();
    vi.mocked(f.api.workspace).mockResolvedValueOnce(f.row as never).mockImplementationOnce(async () => {
      if (change === "account") f.changeAccount(); else f.changeDevice();
      return f.row as never;
    });
    await expect(f.probe()).rejects.toMatchObject({ code: "identity_changed" });
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_ready", outcome: "failed" });
  });

  it.each([undefined, "disabled"] as const)("rechecks the file-backed device before stream ready/skip evidence (%s)", async streamMetadata => {
    let changed!: () => void;
    const f = await fixture({ streamMetadata, beforeStreamReady: () => changed() }); changed = f.changeDevice;
    await expect(f.probe()).rejects.toMatchObject({ code: "identity_changed" });
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_device_stream_ready", outcome: "failed" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("does not downgrade SDK protocol failure into a legacy success", async () => {
    const f = await fixture({ legacyProtocol: true });
    await expect(f.probe(AbortSignal.timeout(500))).rejects.toHaveProperty("code");
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_ready", outcome: "failed" });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.output.some(row => row.outcome === "skipped")).toBe(false);
  });

  it.each(["session", "runtime"] as const)("refuses malformed successful %s responses", async phase => {
    const f = await fixture(), fetcher = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).endsWith(phase === "session" ? "/device-sessions" : "/runtime/connect")
      ? Response.json({ private: "body" }, { status: 201 }) : fetcher(url, init));
    await expect(f.probe()).rejects.toMatchObject({ code: "bad_response" });
    expect(f.output.at(-1)).toMatchObject({ phase: phase === "session" ? "sdk_device_session" : "sdk_runtime_connect", outcome: "failed" });
  });

  it.each(["Local", "foreign-org", "cleanup-only", "not-infrastructure"] as const)("does no native admission for %s input", async kind => {
    const f = await fixture();
    if (kind === "Local" || kind === "foreign-org") vi.mocked(f.api.workspace).mockResolvedValue({ ...f.row,
      organizationId: kind === "Local" ? null : randomUUID() } as never);
    else if (kind === "cleanup-only") f.run.cleanupOnly = { handoffSha256: "a".repeat(64), sourceRunSha256: "b".repeat(64) };
    else delete f.run.hourly!.infrastructure;
    await expect(f.probe()).rejects.toHaveProperty("code");
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.urls).toEqual([]);
  });
});
