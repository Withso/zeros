import { describe, expect, it, vi } from "vitest";

import { parseTargets, probe, probeOnce } from "../uptime-probe.mjs";

const json = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("uptime probe", () => {
  it("accepts only plain HTTPS targets", () => {
    expect(parseTargets(" https://api.zeros.build/healthz, ,https://api-beta.zeros.build/healthz ")).toEqual([
      "https://api.zeros.build/healthz", "https://api-beta.zeros.build/healthz",
    ]);
    expect(parseTargets(undefined)).toEqual([]);
    for (const value of ["http://api.zeros.build/healthz", "https://u:p@api.zeros.build/healthz", "https://api.zeros.build/healthz?x=1"])
      expect(() => parseTargets(value)).toThrow(/plain HTTPS/);
  });

  it("reports degraded cloud health without failing, and fails an unreadable or down service", async () => {
    expect(await probeOnce("https://x.test/healthz", json(200, { ok: true }))).toEqual({ failure: null, cloud: "disabled", reasons: [] });
    expect(await probeOnce("https://x.test/healthz", json(200, {
      ok: true, cloudWorkspaces: { operationalState: "degraded", reasons: ["outbox_stalled"] },
    }))).toEqual({ failure: null, cloud: "degraded", reasons: ["outbox_stalled"] });
    expect(await probeOnce("https://x.test/healthz", json(200, {
      ok: true, cloudWorkspaces: { operationalState: "unknown", reasons: ["health_query_failed"] },
    }))).toMatchObject({ failure: "cloud_health_unreadable" });
    expect(await probeOnce("https://x.test/healthz", json(503, { ok: false }))).toEqual({ failure: "http_503" });
    expect(await probeOnce("https://x.test/healthz", json(200, { ok: false }))).toEqual({ failure: "not_ok" });
    expect(await probeOnce("https://x.test/healthz", vi.fn(async () => { throw new TypeError("fetch failed"); })))
      .toEqual({ failure: "unreachable" });
  });

  it("retries a failing target before reporting it", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const pause = vi.fn(async () => undefined);
    expect(await probe("https://x.test/healthz", { fetchImpl, pause })).toMatchObject({ failure: null, attempts: 2 });
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await probe("https://x.test/healthz", { fetchImpl: down, pause })).toMatchObject({ failure: "unreachable", attempts: 3 });
    expect(pause).toHaveBeenCalledTimes(3);
  });
});
