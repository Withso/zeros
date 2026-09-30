import { describe, expect, it, vi } from "vitest";
import { workerQualificationProfile, SMOKE_MODELS } from "./worker-profile";
import { runNativeSmokeCanary } from "../cloud-workspace-validation/lib/native-canary-smoke";

describe("cost-bounded worker qualification profiles", () => {
  it("defaults ordinary image changes to smoke and selects full for native-contract inputs", () => {
    expect(workerQualificationProfile(["apps/desktop/src/engine/files/index.ts"])).toBe("smoke");
    expect(workerQualificationProfile(["styles/zeros-tokens.css"])).toBe("smoke");
    for (const file of ["apps/desktop/src/engine/agents/adapters/codex/adapter.ts", "apps/desktop/src/engine/agents/containment/zsr-boundary.ts",
      "scripts/cloud-workspace-validation/config.ts", "scripts/cloud-workspace-validation/sandbox/qualify-cloud-agent.ts",
      "packages/protocol/src/cloud-agent-execution.ts", "scripts/codegen-codex.cjs", "pnpm-lock.yaml"]) {
      expect(workerQualificationProfile([file])).toBe("full");
      expect(workerQualificationProfile([file], "smoke")).toBe("full");
    }
    expect(workerQualificationProfile([], "full")).toBe("full");
    expect(() => workerQualificationProfile([], "anything")).toThrow("profile");
    expect(SMOKE_MODELS).toEqual({ claude: "claude-haiku-4-5", codex: "gpt-5.6-luna", cursor: "composer-2.5" });
  });
  it("runs exactly two messages plus resume, permissions, stop and revocation with no extended paid turns", async () => {
    const calls: string[] = [];
    const stage = (name: string) => vi.fn(async () => { calls.push(name); });
    await runNativeSmokeCanary({ toolTurn: stage("tool-message"), renew: stage("renew"), retire: stage("retire"), resume: stage("resume"),
      resumeTurn: stage("resume-message"), permission: stage("permission"), stop: stage("stop"), revoke: stage("revoke") });
    expect(calls).toEqual(["tool-message", "renew", "retire", "resume", "resume-message", "permission", "stop", "revoke"]);
  });
  it("stops immediately on a failed smoke stage", async () => {
    const stop = vi.fn();
    await expect(runNativeSmokeCanary({ toolTurn: async () => { throw new Error("synthetic qualification failure"); }, stop } as any)).rejects.toThrow("qualification failure");
    expect(stop).not.toHaveBeenCalled();
  });
});
