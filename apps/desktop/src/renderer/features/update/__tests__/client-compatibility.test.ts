import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClientCompatibilityFetch,
  desktopClientHeader,
  parseClientUpgradeRequired,
} from "../../../../../shared/client-compatibility";

const required = {
  minimumVersion: "0.1.20-alpha.181",
  latestVersion: "0.1.20-alpha.182",
};

describe("desktop control-plane compatibility requests", () => {
  it.each(["alpha", "beta", "dev", "stable"])(
    "tags %s without renaming the persisted channel",
    (channel) => {
      expect(desktopClientHeader(channel, "1.2.3")).toBe(
        `desktop/${channel === "stable" ? "production" : channel}/1.2.3`,
      );
    },
  );

  it("preserves auth, idempotency and caller options while attaching the client header", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true }),
    );
    const requireUpgrade = vi.fn();
    const clientFetch = createClientCompatibilityFetch({
      fetch: fetcher,
      header: () => "desktop/alpha/1.2.3",
      requireUpgrade,
    });
    const signal = new AbortController().signal;
    await clientFetch("https://api.example.test/v1/me", {
      method: "POST",
      signal,
      redirect: "error",
      headers: {
        authorization: "Bearer synthetic-session",
        "Idempotency-Key": "synthetic-request",
      },
      body: "{}",
    });
    const input = fetcher.mock.calls[0][1]!;
    expect(input).toMatchObject({
      method: "POST",
      signal,
      redirect: "error",
      body: "{}",
    });
    expect(new Headers(input.headers).get("X-Zeros-Client")).toBe(
      "desktop/alpha/1.2.3",
    );
    expect(new Headers(input.headers).get("authorization")).toBe(
      "Bearer synthetic-session",
    );
    expect(new Headers(input.headers).get("Idempotency-Key")).toBe(
      "synthetic-request",
    );
    expect(requireUpgrade).not.toHaveBeenCalled();
  });

  it("handles 426 before returning it, leaving the response readable to existing callers", async () => {
    const body = {
      error: {
        code: "client_upgrade_required",
        message: "untrusted-message",
        ...required,
      },
    };
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(body, { status: 426 }),
    );
    const requireUpgrade = vi.fn();
    const clientFetch = createClientCompatibilityFetch({
      fetch: fetcher,
      header: () => "desktop/alpha/1.2.3",
      requireUpgrade,
    });
    const response = await clientFetch("https://api.example.test/v1/me");
    expect(requireUpgrade).toHaveBeenCalledWith(required);
    expect(await response.json()).toEqual(body);
  });

  it.each([
    new Response("invalid", { status: 426 }),
    Response.json(
      {
        error: {
          code: "client_upgrade_required",
          minimumVersion: "<unsafe>",
          latestVersion: "1.2.3",
        },
      },
      { status: 426 },
    ),
  ])(
    "blocks on malformed 426 bodies without exposing their text",
    async (response) => {
      const requireUpgrade = vi.fn();
      const clientFetch = createClientCompatibilityFetch({
        fetch: vi.fn(async () => response),
        header: () => "desktop/alpha/1.2.3",
        requireUpgrade,
      });
      await clientFetch("https://api.example.test/v1/me");
      expect(requireUpgrade).toHaveBeenCalledWith({
        minimumVersion: "",
        latestVersion: "",
      });
    },
  );

  it("does not confuse ordinary authentication failures with a forced upgrade", async () => {
    const requireUpgrade = vi.fn();
    const clientFetch = createClientCompatibilityFetch({
      fetch: vi.fn(async () =>
        Response.json({ error: "signed_out" }, { status: 401 }),
      ),
      header: () => "desktop/alpha/1.2.3",
      requireUpgrade,
    });
    expect((await clientFetch("https://api.example.test/v1/me")).status).toBe(
      401,
    );
    expect(requireUpgrade).not.toHaveBeenCalled();
  });

  it("validates upgrade IPC metadata without trusting remote messages or extra fields", () => {
    expect(
      parseClientUpgradeRequired({
        ...required,
        message: "private-value",
        extra: "ignored",
      }),
    ).toEqual(required);
    expect(
      parseClientUpgradeRequired({ ...required, minimumVersion: "<html>" }),
    ).toBeNull();
    expect(parseClientUpgradeRequired(null)).toBeNull();
  });

  it("preserves Request headers and overwrites a stale caller-supplied identity", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true }),
    );
    const clientFetch = createClientCompatibilityFetch({
      fetch: fetcher,
      header: () => "desktop/beta/1.2.3",
      requireUpgrade: vi.fn(),
    });
    await clientFetch(
      new Request("https://api.example.test/v1/me", {
        headers: {
          authorization: "Bearer synthetic-session",
          "X-Zeros-Client": "desktop/alpha/0.0.0",
        },
      }),
    );
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe("Bearer synthetic-session");
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).get("X-Zeros-Client"),
    ).toBe("desktop/beta/1.2.3");
  });
});

const runtime = vi.hoisted(() => ({
  isElectron: vi.fn(() => true),
  nativeInvoke: vi.fn(),
  channel: "alpha",
}));
vi.mock("@/renderer/platform/runtime", () => runtime);
vi.mock("@/renderer/config/release-channel", () => ({
  get CHANNEL() {
    return runtime.channel;
  },
}));

describe("renderer request identity and 426 state", () => {
  beforeEach(() => {
    vi.resetModules();
    runtime.nativeInvoke
      .mockReset()
      .mockResolvedValue({ channel: "alpha", version: "0.1.20-alpha.180" });
    runtime.isElectron.mockReturnValue(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shares the authoritative app-info read across concurrent requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );
    const { controlPlaneFetch } = await import("../control-plane-fetch");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        controlPlaneFetch("https://api.example.test/v1/me"),
      ),
    );
    expect(runtime.nativeInvoke).toHaveBeenCalledExactlyOnceWith("app_info");
    expect(
      new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get(
        "X-Zeros-Client",
      ),
    ).toBe("desktop/alpha/0.1.20-alpha.180");
  });

  it("keeps unpackaged Alpha-branded builds on the always-supported dev identity", async () => {
    runtime.nativeInvoke.mockResolvedValue({
      channel: "alpha",
      runtimeMode: "dev",
      version: "0.1.0",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );
    const { controlPlaneFetch } = await import("../control-plane-fetch");
    await controlPlaneFetch("https://api.example.test/v1/me");
    expect(
      new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get(
        "X-Zeros-Client",
      ),
    ).toBe("desktop/dev/0.1.0");
  });

  it("records a sticky requirement and synchronizes it to main without installing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "client_upgrade_required", ...required } },
          { status: 426 },
        ),
      ),
    );
    const { controlPlaneFetch } = await import("../control-plane-fetch");
    const { useRequiredUpdateStore } = await import("../required-update-state");
    await controlPlaneFetch("https://api.example.test/v1/me");
    const snapshot = useRequiredUpdateStore.getState().required;
    expect(snapshot).toEqual(required);
    await controlPlaneFetch("https://api.example.test/v1/me");
    expect(useRequiredUpdateStore.getState().required).toBe(snapshot);
    expect(runtime.nativeInvoke).toHaveBeenCalledWith(
      "updater_require",
      required,
    );
    expect(
      runtime.nativeInvoke.mock.calls.some(
        ([command]) => command === "updater_install",
      ),
    ).toBe(false);
  });

  it("cannot regress a newer requirement when an older 426 response arrives late", async () => {
    const { useRequiredUpdateStore } = await import("../required-update-state");
    useRequiredUpdateStore.getState().requireUpdate(required);
    const snapshot = useRequiredUpdateStore.getState().required;
    useRequiredUpdateStore.getState().requireUpdate({
      minimumVersion: "0.1.20-alpha.180",
      latestVersion: "0.1.20-alpha.181",
    });
    expect(useRequiredUpdateStore.getState().required).toBe(snapshot);
  });
});
