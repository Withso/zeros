import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  channel: "alpha",
  requireClientUpgrade: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getVersion: () => "0.1.20-alpha.180" } }));
vi.mock("../client-upgrade-signal", () => ({
  signalClientUpgrade: state.requireClientUpgrade,
}));
vi.mock("../runtime-mode", () => ({ IS_DEV: false, IS_LOCAL_DEVELOPMENT: false }));
vi.mock("../../src/engine/runtime", () => ({ channel: () => state.channel }));
import { controlPlaneFetch } from "../control-plane-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
  state.requireClientUpgrade.mockClear();
});
describe("Electron user API requests", () => {
  it("uses compatibility fetch for auth snapshots and security streams", () => {
    const main = readFileSync("apps/desktop/electron/main.ts", "utf8");
    const monitor = /new WorkOSDesktopSecurityMonitor\(\{([\s\S]*?)\}\)/.exec(
      main,
    );
    expect(monitor?.[1]).toMatch(/fetch:\s*controlPlaneFetch/);
    expect(main).toContain('from "./control-plane-fetch"');
  });
  it.each(["alpha", "beta", "stable", "dev"])(
    "sends the main process's %s identity",
    async (channel) => {
      state.channel = channel;
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({ ok: true }),
      );
      vi.stubGlobal("fetch", fetcher);
      await controlPlaneFetch("https://api.example.test/v1/me", {
        headers: { authorization: "Bearer synthetic-session" },
      });
      expect(
        new Headers(fetcher.mock.calls[0][1]?.headers).get("X-Zeros-Client"),
      ).toBe(
        `desktop/${channel === "stable" ? "production" : channel}/0.1.20-alpha.180`,
      );
    },
  );
  it("records 426 in main before existing clients parse the failure", async () => {
    const required = { minimumVersion: "1.2.3", latestVersion: "1.2.4" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "client_upgrade_required", ...required } },
          { status: 426 },
        ),
      ),
    );
    const response = await controlPlaneFetch(
      "https://api.example.test/v1/devices",
    );
    expect(state.requireClientUpgrade).toHaveBeenCalledWith(required);
    expect(await response.json()).toMatchObject({ error: required });
  });
});
