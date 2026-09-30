import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientCompatibility,
  createClientCompatibilityMiddleware,
  releaseLedgerUrl,
} from "./client-compatibility.js";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import type pg from "pg";
import { createApp } from "./app.js";

const now = Date.parse("2026-09-30T12:00:00Z");
const releases = [
  {
    version: "0.1.20-alpha.180",
    publishedAt: "2026-08-01T12:00:00Z",
    sourceSha: "a".repeat(40),
  },
  {
    version: "0.1.20-alpha.181",
    publishedAt: "2026-08-31T12:00:00Z",
    sourceSha: "b".repeat(40),
  },
  {
    version: "0.1.20-alpha.182",
    publishedAt: "2026-09-15T12:00:00Z",
    sourceSha: "c".repeat(40),
  },
];
const ledger = { version: 1, channel: "alpha", releases };

function harness(body: unknown = ledger) {
  const fetchLedger = vi.fn(async () => Response.json(body));
  const warn = vi.fn();
  const compatibility = new ClientCompatibility({
    fetch: fetchLedger,
    now: () => now,
    warn,
  });
  const app = new Hono();
  app.use("*", createClientCompatibilityMiddleware(compatibility));
  app.all("*", (context) => context.json({ ok: true }));
  return { compatibility, app, fetchLedger, warn };
}

afterEach(() => vi.useRealTimers());

describe("desktop support window", () => {
  it.each([
    ["0.1.20-alpha.182", 200],
    ["0.1.20-alpha.181", 200],
    ["0.1.20-alpha.180", 426],
    ["0.1.20-alpha.179", 426],
    ["0.1.20-alpha.183", 200],
  ])("evaluates %s against its next release (%s)", async (version, status) => {
    const { app } = harness();
    const response = await app.request("/v1/me", {
      headers: { "X-Zeros-Client": `desktop/alpha/${version}` },
    });
    expect(response.status).toBe(status);
    if (status === 426) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: {
          code: "client_upgrade_required",
          message: expect.any(String),
          minimumVersion: releases[1].version,
          latestVersion: releases[2].version,
        },
      });
    }
  });

  it("supports the newest entry even when it was published over 30 days ago", async () => {
    const { compatibility } = harness({
      ...ledger,
      releases: releases.slice(0, 1),
    });
    expect(
      await compatibility.check("desktop/alpha/0.1.20-alpha.180"),
    ).toBeNull();
  });

  it("expires exactly 30 days after the next newer release, not the client's publication", async () => {
    const fetchLedger = vi.fn(async () => Response.json(ledger));
    let clock = now - 1;
    const compatibility = new ClientCompatibility({
      fetch: fetchLedger,
      now: () => clock,
    });
    expect(
      await compatibility.check("desktop/alpha/0.1.20-alpha.180"),
    ).toBeNull();
    clock = now;
    expect(
      await compatibility.check("desktop/alpha/0.1.20-alpha.180"),
    ).not.toBeNull();
    expect(fetchLedger).toHaveBeenCalledOnce();
  });

  it("compares prerelease numbers numerically and evaluates versions absent from the bounded ledger", async () => {
    const { compatibility } = harness({
      ...ledger,
      releases: [
        { ...releases[0], version: "1.2.3-alpha.9" },
        { ...releases[1], version: "1.2.3-alpha.12" },
        { ...releases[2], version: "1.2.3-alpha.20" },
      ],
    });
    expect(
      await compatibility.check("desktop/alpha/1.2.3-alpha.10"),
    ).not.toBeNull();
    expect(
      await compatibility.check("desktop/alpha/1.2.3-alpha.19"),
    ).toBeNull();
  });

  it.each([
    undefined,
    "",
    "desktop/dev/0.0.0",
    "desktop/unknown/0.0.0",
    "browser/alpha/0.0.0",
    "desktop/alpha/unknown",
  ])(
    "allows pre-feature/web/dev/unknown clients (%s) without fetching",
    async (header) => {
      const { compatibility, fetchLedger } = harness();
      expect(await compatibility.check(header)).toBeNull();
      expect(fetchLedger).not.toHaveBeenCalled();
    },
  );

  it.each([
    "/healthz",
    "/v1/release-identity",
    "/auth/start",
    "/auth/browser/refresh",
    "/auth/logout",
    "/v1/auth/refresh",
    "/v1/auth/logout",
    "/v1/auth/sign-in",
    "/internal/v1/cloud-workspaces/heartbeat",
    "/v1/engine/heartbeat",
  ])("exempts %s", async (path) => {
    const { app, fetchLedger } = harness();
    const response = await app.request(path, {
      headers: { "X-Zeros-Client": "desktop/alpha/0.1.20-alpha.179" },
    });
    expect(response.status).toBe(200);
    expect(fetchLedger).not.toHaveBeenCalled();
  });

  it("does not exempt user authentication snapshots or device operations", async () => {
    const { app } = harness();
    for (const path of [
      "/v1/auth/snapshot",
      "/v1/devices",
      "/v1/cloud-workspaces",
    ]) {
      expect(
        (
          await app.request(path, {
            headers: { "X-Zeros-Client": "desktop/alpha/0.1.20-alpha.179" },
          })
        ).status,
      ).toBe(426);
    }
  });
});

describe("bounded channel ledger cache", () => {
  it("uses the exact feed asset for each channel", () => {
    expect(releaseLedgerUrl("alpha")).toBe(
      "https://github.com/withso/zeros/releases/download/alpha/alpha-release-ledger.json",
    );
    expect(releaseLedgerUrl("beta")).toBe(
      "https://github.com/withso/zeros/releases/download/beta/beta-release-ledger.json",
    );
    expect(releaseLedgerUrl("production")).toBe(
      "https://github.com/withso/zeros/releases/latest/download/release-ledger.json",
    );
  });

  it("deduplicates concurrent reads, reuses fresh snapshots, and bounds their lifetime", async () => {
    let clock = now;
    const fetchLedger = vi.fn(async () => Response.json(ledger));
    const compatibility = new ClientCompatibility({
      fetch: fetchLedger,
      now: () => clock,
    });
    await Promise.all(
      Array.from({ length: 50 }, () =>
        compatibility.check("desktop/alpha/0.1.20-alpha.179"),
      ),
    );
    expect(fetchLedger).toHaveBeenCalledOnce();
    clock += 5 * 60 * 1000;
    await compatibility.check("desktop/alpha/0.1.20-alpha.179");
    expect(fetchLedger).toHaveBeenCalledTimes(2);
  });

  it("keeps channel snapshots isolated and applies an override only to its deployment channel", async () => {
    const fetchLedger = vi.fn(async (url: string | URL | Request) =>
      Response.json({
        ...ledger,
        channel: String(url).includes("beta") ? "beta" : "alpha",
      }),
    );
    const compatibility = new ClientCompatibility({
      fetch: fetchLedger,
      now: () => now,
      deploymentChannel: "alpha",
      ledgerUrl: "https://releases.example.test/alpha-ledger.json",
    });
    await compatibility.check("desktop/alpha/0.1.20-alpha.179");
    await compatibility.check("desktop/beta/0.1.20-alpha.179");
    expect(fetchLedger.mock.calls.map(([url]) => url)).toEqual([
      "https://releases.example.test/alpha-ledger.json",
      releaseLedgerUrl("beta"),
    ]);
  });

  it.each([
    null,
    { ...ledger, version: 2 },
    { ...ledger, channel: "beta" },
    { ...ledger, releases: [] },
    { ...ledger, releases: [...releases].reverse() },
    { ...ledger, releases: [{ ...releases[0], publishedAt: "yesterday" }] },
    {
      ...ledger,
      releases: [{ ...releases[0], publishedAt: "2026-02-31T12:00:00Z" }],
    },
    { ...ledger, releases: [{ ...releases[0], sourceSha: "not-a-sha" }] },
    { ...ledger, releases: Array.from({ length: 201 }, () => releases[0]) },
  ])(
    "fails open on an invalid ledger without logging its contents",
    async (body) => {
      const { compatibility, warn } = harness(body);
      expect(
        await compatibility.check("desktop/alpha/0.1.20-alpha.179"),
      ).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        "[client-compatibility] alpha release ledger unavailable; allowing desktop requests",
      );
    },
  );

  it("fails open on outages, suppresses request storms, and retries after 30 seconds", async () => {
    let clock = now;
    const fetchLedger = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private-network-detail"));
    const warn = vi.fn();
    const compatibility = new ClientCompatibility({
      fetch: fetchLedger,
      now: () => clock,
      warn,
    });
    await Promise.all(
      Array.from({ length: 20 }, () =>
        compatibility.check("desktop/alpha/0.1.20-alpha.179"),
      ),
    );
    expect(fetchLedger).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    clock += 30_000;
    expect(
      await compatibility.check("desktop/alpha/0.1.20-alpha.179"),
    ).toBeNull();
    expect(fetchLedger).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "private-network-detail",
    );
  });

  it("also fails open if a fetch adapter throws synchronously", async () => {
    const compatibility = new ClientCompatibility({
      fetch: vi.fn(() => {
        throw new Error("unavailable");
      }),
      warn: vi.fn(),
    });
    expect(
      await compatibility.check("desktop/alpha/0.1.20-alpha.179"),
    ).toBeNull();
  });

  it("does not enforce an expired cache during a ledger outage", async () => {
    let clock = now;
    const fetchLedger = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(ledger))
      .mockRejectedValue(new Error("offline"));
    const compatibility = new ClientCompatibility({
      fetch: fetchLedger,
      now: () => clock,
      warn: vi.fn(),
    });
    expect(
      await compatibility.check("desktop/alpha/0.1.20-alpha.179"),
    ).not.toBeNull();
    clock += 5 * 60 * 1000;
    expect(
      await compatibility.check("desktop/alpha/0.1.20-alpha.179"),
    ).toBeNull();
  });

  it("times out even when a fetch implementation ignores its abort signal", async () => {
    vi.useFakeTimers();
    const fetchLedger = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const compatibility = new ClientCompatibility({
      fetch: fetchLedger,
      warn: vi.fn(),
    });
    const pending = compatibility.check("desktop/alpha/0.1.20-alpha.179");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBeNull();
    expect(fetchLedger.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("bounds response bytes and rejects unsuccessful fetches", async () => {
    for (const response of [
      new Response("x".repeat(65_537)),
      new Response("missing", { status: 404 }),
    ]) {
      const compatibility = new ClientCompatibility({
        fetch: vi.fn(async () => response),
        warn: vi.fn(),
      });
      expect(
        await compatibility.check("desktop/alpha/0.1.20-alpha.179"),
      ).toBeNull();
    }
  });
});

describe("release ledger override configuration", () => {
  const env = {
    DATABASE_URL: "postgres://user:pass@localhost:5432/zeros",
    AUTH0_DOMAIN: "tenant.example.test",
    AUTH_AUDIENCE: "https://api.zeros.build",
  };
  it("uses defaults when unset and accepts a credential-free HTTPS override", () => {
    expect(loadConfig(env).desktopReleaseLedgerUrl).toBeNull();
    expect(
      loadConfig({
        ...env,
        DESKTOP_RELEASE_LEDGER_URL: "https://releases.example.test/ledger.json",
      }).desktopReleaseLedgerUrl,
    ).toBe("https://releases.example.test/ledger.json");
  });
  it.each([
    "http://releases.example.test/ledger.json",
    "https://user:pass@releases.example.test/ledger.json",
    "not-a-url",
  ])("rejects %s", (url) => {
    expect(() =>
      loadConfig({ ...env, DESKTOP_RELEASE_LEDGER_URL: url }),
    ).toThrow("DESKTOP_RELEASE_LEDGER_URL");
  });
});

describe("control-plane middleware wiring", () => {
  const config: Config = {
    databaseUrl: "postgres://unused",
    auth: {
      provider: "auth0",
      issuers: ["https://tenant.example.test/"],
      jwksUrl: "https://tenant.example.test/jwks.json",
      audience: "https://api.example.test",
    },
    workos: null,
    inviteLinkBase: "https://app.example.test/invite",
    port: 8080,
    isProduction: true,
    deploymentChannel: "alpha",
    github: null,
    feedback: null,
    cloudWorkspaces: null,
  };
  it("blocks unsupported user requests before dispatch, retains auth for untagged callers and allows CORS", async () => {
    const { compatibility, fetchLedger } = harness();
    const query = vi.fn(async () => ({ rows: [] }));
    const app = createApp(
      config,
      { query } as unknown as pg.Pool,
      { from: null, token: null, apiUrl: "", inviteLinkBase: "" },
      { clientCompatibility: compatibility },
    );
    const headers = {
      "X-Zeros-Client": "desktop/alpha/0.1.20-alpha.179",
      origin: "http://localhost:5173",
    };
    expect((await app.request("/v1/me", { headers })).status).toBe(426);
    expect(query).not.toHaveBeenCalled();
    expect((await app.request("/v1/me")).status).toBe(401);
    const preflight = await app.request("/v1/me", {
      method: "OPTIONS",
      headers: {
        ...headers,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-zeros-client",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
      "x-zeros-client",
    );
    expect(fetchLedger).toHaveBeenCalledOnce();
  });
  it("keeps health, release readiness, auth and engine/internal paths outside compatibility enforcement", async () => {
    const { compatibility, fetchLedger } = harness();
    const app = createApp(
      config,
      { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool,
      { from: null, token: null, apiUrl: "", inviteLinkBase: "" },
      { clientCompatibility: compatibility },
    );
    for (const path of [
      "/healthz",
      "/v1/release-identity",
      "/auth/start",
      "/auth/browser/refresh",
      "/auth/logout",
      "/internal/v1/cloud-workspaces/heartbeat",
    ]) {
      expect(
        (
          await app.request(path, {
            headers: { "X-Zeros-Client": "desktop/alpha/0.1.20-alpha.179" },
          })
        ).status,
      ).not.toBe(426);
    }
    expect(fetchLedger).not.toHaveBeenCalled();
  });
});
