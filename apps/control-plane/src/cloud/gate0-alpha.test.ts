import { describe, expect, it } from "vitest";
import { alphaProbeAgents, alphaProbeIdentity, alphaProbeOrganization, alphaProbeReport } from "./gate0-alpha.js";

const healthy = {
  version: 1, channel: "alpha", ready: true, maintenance: false, sourceSha: "a".repeat(40),
  cloud: { enabled: true, ready: true, state: "healthy" }, worker: { sha256: "b".repeat(64) },
};

describe("Alpha probe target", () => {
  it("reads the deployed source and worker from a ready, healthy Alpha only", () => {
    expect(alphaProbeIdentity(healthy)).toEqual({ sourceSha: "a".repeat(40), workerSha256: "b".repeat(64) });
    for (const value of [
      { ...healthy, channel: "production" }, { ...healthy, ready: false }, { ...healthy, maintenance: true },
      { ...healthy, cloud: { ...healthy.cloud, state: "degraded" } }, { ...healthy, worker: null }, null,
    ]) expect(() => alphaProbeIdentity(value)).toThrow("alpha_release_identity");
  });

  const me = { organizations: [
    { id: "11111111-1111-4111-8111-111111111111", slug: "zeros" },
    { id: "22222222-2222-4222-8222-222222222222", slug: "zeros-phase-0" },
  ] };
  it("uses only an explicitly selected organization, by slug or ID", () => {
    expect(alphaProbeOrganization(me, "zeros-phase-0")).toEqual(me.organizations[1]);
    expect(alphaProbeOrganization(me, "22222222-2222-4222-8222-222222222222")).toEqual(me.organizations[1]);
    // Never falls back to the only, first or team organization the login can see.
    for (const selector of [undefined, "", "missing", "ZEROS-PHASE-0"]) expect(() => alphaProbeOrganization(me, selector)).toThrow("alpha_organization");
  });

  const connections = [{ provider: "claude", connected: true }, { provider: "codex", connected: false }, { provider: "cursor", connected: true }];
  it("defaults to the organization's connected agents and refuses a requested one that is not connected", () => {
    expect(alphaProbeAgents(undefined, connections)).toEqual({ agents: ["claude", "cursor"], skipped: ["codex"] });
    expect(alphaProbeAgents("cursor", connections)).toEqual({ agents: ["cursor"], skipped: ["codex", "claude"] });
    expect(() => alphaProbeAgents("codex,claude", connections)).toThrow("agent_codex_login");
    expect(() => alphaProbeAgents("claude,claude", connections)).toThrow("agent_selection");
    expect(() => alphaProbeAgents(undefined, [])).toThrow("agent_selection");
  });

  it("reports VM time and an estimate only from an explicit hourly rate, with no identifiers beyond the target", () => {
    const base = { identity: { sourceSha: "a".repeat(40), workerSha256: "b".repeat(64) }, organization: "zeros-phase-0",
      agents: ["claude"] as const, skipped: ["codex", "cursor"] as const, metrics: [{ name: "create_request", ms: 350 }],
      workerTimings: [], startedAt: "2026-11-15T00:00:00.000Z" };
    const passed = alphaProbeReport({ ...base, result: { workspaceId: "w", agents: ["claude"], deleted: true, metrics: base.metrics, vmRunningMs: 90_000, turns: 2 } });
    expect(passed).toMatchObject({ target: "alpha", outcome: "passed", deleted: true, vm: { runningSeconds: 90 }, turns: 2 });
    expect(passed.vm).not.toHaveProperty("estimatedDollars");
    expect(passed).toMatchObject({ agentCost: null });
    expect(alphaProbeReport({ ...base, result: { workspaceId: "w", agents: ["claude"], deleted: true, metrics: [], vmRunningMs: 0, turns: 2,
      agentCost: { totalUsd: 0.0123, estimated: true } } })).toMatchObject({ agentCost: { totalUsd: 0.0123, estimated: true } });
    expect(alphaProbeReport({ ...base, dollarsPerHour: 0.4, result: { workspaceId: "w", agents: ["claude"], deleted: true, metrics: [], vmRunningMs: 90_000, turns: 2 } }).vm)
      .toEqual({ runningSeconds: 90, dollarsPerHour: 0.4, estimatedDollars: 0.01 });
    expect(alphaProbeReport({ ...base, failure: "agent_claude_turn" })).toMatchObject({ outcome: "failed", failure: "agent_claude_turn", metrics: base.metrics });
    expect(alphaProbeReport({ ...base, failure: "history_mirror", failureCause: "bridge_closed_1006" })).toMatchObject({ failure: "history_mirror", failureCause: "bridge_closed_1006" });
    expect(JSON.stringify(passed)).not.toContain("\"w\"");
  });
});
