import { describe, expect, it, vi } from "vitest";
import { alphaFrontierIdentity } from "./alpha-frontier";

const identity = {
  version: 1, ready: true, sourceSha: "a".repeat(40), channel: "alpha", maintenance: false,
  migrations: { state: "current", head: "0001_fixture.sql", expectedHead: "0001_fixture.sql", manifestSha256: "b".repeat(64) },
  cloud: { enabled: true, ready: true, state: "healthy" }, worker: null, workerQualified: false,
};

describe("Alpha frontier transport recovery", () => {
  it.each(["network", 408, 429, 500, 502, 504])("retries a transient %s failure before accepting a fresh identity", async failure => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      if (failure === "network") throw new Error("private transport diagnostics");
      return new Response("private gateway diagnostics", { status: Number(failure) });
    }).mockResolvedValueOnce(Response.json(identity));
    const pause = vi.fn(async () => {});
    await expect(alphaFrontierIdentity(fetcher, pause)).resolves.toMatchObject(identity);
    expect(pause).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe("https://api-alpha.zeros.build/v1/release-identity");
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store", headers: { accept: "application/json" } });
    }
  });

  it("aborts a timed-out request before retrying, without accepting its late response", async () => {
    vi.useFakeTimers();
    try {
      let late!: (response: Response) => void;
      const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { late = resolve; }))
        .mockResolvedValueOnce(Response.json({ ...identity, sourceSha: "c".repeat(40) }));
      const result = alphaFrontierIdentity(fetcher, async () => {});
      await vi.advanceTimersByTimeAsync(5_001);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      late(Response.json(identity));
      await expect(result).resolves.toMatchObject({ sourceSha: "c".repeat(40) });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("bounds persistent transport failure to three attempts and never returns a cached identity", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private transport diagnostics"));
    const pause = vi.fn(async () => {});
    await expect(alphaFrontierIdentity(fetcher, pause)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(pause.mock.calls).toEqual([[1_000], [2_000]]);
  });

  it("bounds three stalled requests including the real backoffs to eighteen seconds", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
      const result = alphaFrontierIdentity(fetcher);
      await vi.advanceTimersByTimeAsync(18_001);
      await expect(result).resolves.toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("retries an unavailable gateway's non-JSON 503 while refusing malformed HTTP 200", async () => {
    for (const status of [503, 200]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("private gateway diagnostics", { status }))
        .mockResolvedValueOnce(Response.json(identity));
      const pause = vi.fn(async () => {});
      const result = await alphaFrontierIdentity(fetcher, pause);
      expect(result).toEqual(status === 503 ? identity : null);
      expect(fetcher).toHaveBeenCalledTimes(status === 503 ? 2 : 1);
    }
  });

  it.each([
    { ...identity, maintenance: true },
    { ...identity, channel: "beta" },
    { ...identity, sourceSha: "invalid" },
    { ...identity, migrations: { ...identity.migrations, state: "pending" } },
    { ...identity, migrations: { ...identity.migrations, head: "0002_future.sql" } },
  ])("does not retry a semantic refusal after transport recovery %#", async invalid => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("private transport diagnostics"))
      .mockResolvedValueOnce(Response.json(invalid, { status: 503 })).mockResolvedValue(Response.json(identity));
    const pause = vi.fn(async () => {});
    await expect(alphaFrontierIdentity(fetcher, pause)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledOnce();
  });
});
