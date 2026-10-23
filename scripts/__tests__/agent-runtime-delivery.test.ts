import { describe, expect, it, vi } from "vitest";
import {
  includesCommit,
  collectDelivery,
  validateLedger,
} from "../agent-runtime/delivery.mjs";
import { renderDashboard } from "../agent-runtime/report.mjs";
import { initialState } from "../agent-runtime/state.mjs";
const source = "a".repeat(40);

describe("desktop and cloud delivery evidence", () => {
  it("does not treat a saved legacy runtime receipt as v2 delivery or query its retired publisher", async () => {
    const now = "2026-10-21T00:00:00.000Z";
    const state = initialState(now);
    state.sources["codex-delivery"] = {
      status: "complete",
      lastGood: { data: { cloud: { status: "published", pin: "9.9.9" } } },
    };
    const get = vi.fn(async () => { throw Object.assign(new Error("No release"), { status: 404 }); });
    const observations = await collectDelivery({ get }, state, now);
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      "/releases/tags/alpha", "/releases/tags/beta", "/releases/latest",
    ]);
    expect(observations).toHaveLength(3);
    for (const observation of observations) {
      expect(observation.data.cloud).toEqual({
        status: "unknown", qualification: "unknown", reason: "v2-delivery-not-observed",
      });
    }
    // Even when a current desktop read fails and state retains lastGood, the
    // dashboard must never present the old publisher's receipt as v2 evidence.
    const dashboard = renderDashboard(state, 1);
    expect(dashboard).not.toContain("9.9.9");
    expect(dashboard).toContain("v2 delivery is not observed");
  });
  it("validates channel identity and immutable release sources", () => {
    const ledger = {
      version: 1,
      channel: "alpha",
      releases: [
        {
          version: "0.1.0-alpha.4",
          sourceSha: source,
          publishedAt: "2026-10-12T00:00:00.000Z",
        },
      ],
    };
    expect(validateLedger(ledger, "alpha")).toBe(ledger);
    expect(() => validateLedger(ledger, "beta")).toThrow();
    expect(() =>
      validateLedger(
        { ...ledger, releases: [ledger.releases[0], ledger.releases[0]] },
        "alpha",
      ),
    ).toThrow();
  });
  it("uses source ancestry to recognize inclusion by a later release", async () => {
    const github = { get: async () => ({ status: "ahead" }) };
    expect(await includesCommit(github, source, "b".repeat(40))).toBe(true);
    expect(
      await includesCommit(
        { get: async () => ({ status: "diverged" }) },
        source,
        "b".repeat(40),
      ),
    ).toBe(false);
    expect(
      await includesCommit(
        {
          get: async () => {
            throw new Error("unavailable");
          },
        },
        source,
        "b".repeat(40),
      ),
    ).toBe("unknown");
  });
});
