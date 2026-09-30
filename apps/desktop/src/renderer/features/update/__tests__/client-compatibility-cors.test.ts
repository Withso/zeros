import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientCompatibilityFetch } from "../../../../../shared/client-compatibility";

const clientHeader = "desktop/alpha/1.2.3";
const apiUrl = "https://api.example.test/v1/me";
const required = { minimumVersion: "1.2.4", latestVersion: "1.2.5" };

function clientHeaders(calls: Parameters<typeof fetch>[]): (string | null)[] {
  return calls.map(([, init]) =>
    new Headers(init?.headers).get("X-Zeros-Client"),
  );
}

function oldApiClient(status = 200) {
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    if (new Headers(init?.headers).has("X-Zeros-Client"))
      throw new TypeError("Failed to fetch");
    return Response.json({ ok: true }, { status });
  });
  const requireUpgrade = vi.fn();
  const clientFetch = createClientCompatibilityFetch({
    fetch: fetcher,
    header: () => clientHeader,
    requireUpgrade,
  });
  return { fetcher, clientFetch, requireUpgrade };
}

afterEach(() => vi.restoreAllMocks());

describe("old API client-header CORS tolerance", () => {
  it.each([200, 401, 404, 500])(
    "learns from a headerless GET resolving with %s and sends later writes without the header",
    async (status) => {
      const { fetcher, clientFetch } = oldApiClient(status);
      const beforeRequest = vi.fn();
      const signal = new AbortController().signal;
      const response = await clientFetch(
        apiUrl,
        {
          signal,
          redirect: "error",
          cache: "no-store",
          headers: { authorization: "Bearer synthetic-session" },
        },
        beforeRequest,
      );
      expect(response.status).toBe(status);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(beforeRequest).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1][1]).toMatchObject({
        signal,
        redirect: "error",
        cache: "no-store",
      });
      expect(
        fetcher.mock.calls.map(([, init]) =>
          new Headers(init?.headers).get("authorization"),
        ),
      ).toEqual(["Bearer synthetic-session", "Bearer synthetic-session"]);

      await clientFetch(apiUrl, {
        method: "POST",
        headers: {
          "X-Zeros-Client": "desktop/beta/0.0.0",
          "Idempotency-Key": "synthetic-operation",
        },
        body: "{}",
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(clientHeaders(fetcher.mock.calls)).toEqual([
        clientHeader,
        null,
        null,
      ]);
      expect(fetcher.mock.calls[2][1]).toMatchObject({
        method: "POST",
        body: "{}",
      });
      expect(
        new Headers(fetcher.mock.calls[2][1]?.headers).get("Idempotency-Key"),
      ).toBe("synthetic-operation");
    },
  );

  it.each(["GET", "HEAD"])(
    "retries a %s Request exactly once and preserves its other headers",
    async (method) => {
      const { fetcher, clientFetch } = oldApiClient();
      const request = new Request(apiUrl, {
        method,
        headers: { authorization: "Bearer synthetic-session" },
      });
      expect((await clientFetch(request)).status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(clientHeaders(fetcher.mock.calls)).toEqual([clientHeader, null]);
      expect(
        new Headers(fetcher.mock.calls[1][1]?.headers).get("authorization"),
      ).toBe("Bearer synthetic-session");
      expect(request.method).toBe(method);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "never duplicates a %s before header rejection is known",
    async (method) => {
      const { fetcher, clientFetch } = oldApiClient();
      await expect(clientFetch(apiUrl, { method })).rejects.toThrow(TypeError);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(clientHeaders(fetcher.mock.calls)).toEqual([clientHeader]);
      await clientFetch(apiUrl);
      expect(clientHeaders(fetcher.mock.calls)).toEqual([
        clientHeader,
        clientHeader,
        null,
      ]);
    },
  );

  it("does not mistake a POST Request for the default GET", async () => {
    const { fetcher, clientFetch } = oldApiClient();
    await expect(
      clientFetch(new Request(apiUrl, { method: "POST" })),
    ).rejects.toThrow(TypeError);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses init.method ahead of Request.method", async () => {
    const { fetcher, clientFetch } = oldApiClient();
    await expect(
      clientFetch(new Request(apiUrl), { method: "POST" }),
    ).rejects.toThrow(TypeError);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      (
        await clientFetch(new Request(apiUrl, { method: "POST" }), {
          method: "get",
        })
      ).status,
    ).toBe(200);
    expect(clientHeaders(fetcher.mock.calls)).toEqual([
      clientHeader,
      clientHeader,
      null,
    ]);
  });

  it("expires learning after ten minutes and restores header and 426 enforcement", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const { fetcher, clientFetch, requireUpgrade } = oldApiClient();
    await clientFetch(apiUrl);
    clock.mockReturnValue(10 * 60_000 - 1);
    await clientFetch(apiUrl, { method: "POST" });
    clock.mockReturnValue(10 * 60_000);
    fetcher.mockImplementationOnce(async () =>
      Response.json(
        { error: { code: "client_upgrade_required", ...required } },
        { status: 426 },
      ),
    );
    const response = await clientFetch(apiUrl);
    expect(response.status).toBe(426);
    expect(requireUpgrade).toHaveBeenCalledWith(required);
    expect(clientHeaders(fetcher.mock.calls)).toEqual([
      clientHeader,
      null,
      null,
      clientHeader,
    ]);
    expect(await response.json()).toMatchObject({ error: required });
  });

  it("keeps the header and surfaces 426 on a new API without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { code: "client_upgrade_required", ...required } },
        { status: 426 },
      ),
    );
    const requireUpgrade = vi.fn();
    const clientFetch = createClientCompatibilityFetch({
      fetch: fetcher,
      header: () => clientHeader,
      requireUpgrade,
    });
    expect((await clientFetch(apiUrl)).status).toBe(426);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(clientHeaders(fetcher.mock.calls)).toEqual([clientHeader]);
    expect(requireUpgrade).toHaveBeenCalledWith(required);
  });

  it("also surfaces 426 from the headerless fallback", async () => {
    const { fetcher, clientFetch, requireUpgrade } = oldApiClient();
    fetcher.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fetcher.mockResolvedValueOnce(
      Response.json(
        { error: { code: "client_upgrade_required", ...required } },
        { status: 426 },
      ),
    );
    expect((await clientFetch(apiUrl)).status).toBe(426);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requireUpgrade).toHaveBeenCalledWith(required);
  });

  it("rethrows a genuine network failure after one GET retry without learning", async () => {
    const { fetcher, clientFetch } = oldApiClient();
    const failure = new TypeError("Network unavailable");
    fetcher.mockRejectedValue(failure);
    await expect(clientFetch(apiUrl)).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(clientHeaders(fetcher.mock.calls)).toEqual([clientHeader, null]);
    fetcher.mockResolvedValueOnce(Response.json({ ok: true }));
    await clientFetch(apiUrl);
    expect(clientHeaders(fetcher.mock.calls)).toEqual([
      clientHeader,
      null,
      clientHeader,
    ]);
  });

  it("does not retry a failure when the header was already omitted", async () => {
    const { fetcher, clientFetch } = oldApiClient();
    await clientFetch(apiUrl);
    const failure = new TypeError("Network unavailable");
    fetcher.mockRejectedValueOnce(failure);
    await expect(clientFetch(apiUrl)).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(clientHeaders(fetcher.mock.calls)).toEqual([
      clientHeader,
      null,
      null,
    ]);
  });

  it("does not share rejection learning between API origins", async () => {
    const { fetcher, clientFetch } = oldApiClient();
    await clientFetch(apiUrl);
    await expect(
      clientFetch("https://other-api.example.test/v1/me", { method: "POST" }),
    ).rejects.toThrow(TypeError);
    expect(clientHeaders(fetcher.mock.calls)).toEqual([
      clientHeader,
      null,
      clientHeader,
    ]);
  });

  it("bounds remembered API origins to 32 entries", async () => {
    const { fetcher, clientFetch } = oldApiClient();
    for (let index = 0; index < 33; index += 1)
      await clientFetch(`https://api-${index}.example.test/v1/me`);
    const previousCalls = fetcher.mock.calls.length;
    await clientFetch("https://api-0.example.test/v1/me");
    await clientFetch("https://api-32.example.test/v1/me", { method: "POST" });
    expect(clientHeaders(fetcher.mock.calls.slice(previousCalls))).toEqual([
      clientHeader,
      null,
      null,
    ]);
  });

  it.each([
    new Error("Unavailable"),
    new DOMException("Aborted", "AbortError"),
  ])("does not retry non-TypeError fetch failures", async (failure) => {
    const { fetcher, clientFetch } = oldApiClient();
    fetcher.mockRejectedValue(failure);
    await expect(clientFetch(apiUrl)).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not interpret an account-fence TypeError as a fetch failure", async () => {
    const { fetcher, clientFetch } = oldApiClient();
    const failure = new TypeError("Account changed");
    const beforeRequest = vi.fn(() => {
      throw failure;
    });
    await expect(clientFetch(apiUrl, undefined, beforeRequest)).rejects.toBe(
      failure,
    );
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not interpret an identity TypeError as a fetch failure", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const failure = new TypeError("Identity unavailable");
    const clientFetch = createClientCompatibilityFetch({
      fetch: fetcher,
      header: () => Promise.reject(failure),
      requireUpgrade: vi.fn(),
    });
    await expect(clientFetch(apiUrl)).rejects.toBe(failure);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
