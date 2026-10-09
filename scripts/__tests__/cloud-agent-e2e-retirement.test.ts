import { describe, expect, it } from "vitest";
import { assertRetirement, awaitRetirement, summarizeRetirement } from "../cloud-workspace-validation/cloud-agent-e2e/retirement";

const proof = { engineScopeEmpty: true, cgroupRemoved: true, namespacePrivate: true };
describe("namespace retirement evidence", () => {
  it("reports a retired partial namespace independently from a failed provider turn", () => {
    const partial = { ...proof, scopeKind: "cpu-private-pid-fixture" as const, cgroupRemoved: false, pidNamespaceProcessesEmpty: true, ownCpuCgroupRemoved: true };
    expect(summarizeRetirement({ code: 0, signal: null }, { proof: partial })).toEqual({ status: "passed", pidNamespaceRetired: true });
    expect(summarizeRetirement(undefined, {})).toEqual({ status: "pending", pidNamespaceRetired: false });
    expect(summarizeRetirement({ code: 1, signal: null }, { proof: partial })).toEqual({ status: "failed", pidNamespaceRetired: false });
  });
  it("requires a successful exit and explicit emptied-domain proof", () => {
    expect(() => assertRetirement({ code: 0, signal: null }, { proof })).not.toThrow();
    expect(() => assertRetirement({ code: 0, signal: null }, {})).toThrow("cleanup_unconfirmed");
    expect(() => assertRetirement({ code: 0, signal: null }, { proof: { ...proof, engineScopeEmpty: false } })).toThrow("cleanup_unconfirmed");
  });
  it("refuses nonzero and forced SIGKILL even if an earlier proof appeared", () => {
    expect(() => assertRetirement({ code: 1, signal: null }, { proof })).toThrow("cleanup_unconfirmed");
    expect(() => assertRetirement({ code: null, signal: "SIGKILL" }, { proof })).toThrow("cleanup_unconfirmed");
  });
  it("refuses a late cleanup failure after a positive proof", () => {
    expect(() => assertRetirement({ code: 0, signal: null }, { proof, failure: true })).toThrow("cleanup_unconfirmed");
  });
  it("waits for final stdio completion before evaluating late namespace diagnostics", async () => {
    const evidence: { proof: typeof proof; failure?: boolean } = { proof };
    let resolve!: (result: { code: number; signal: null }) => void;
    const completed = new Promise<{ code: number; signal: null }>(callback => { resolve = callback; });
    const work = awaitRetirement(completed, () => evidence);
    evidence.failure = true; resolve({ code: 0, signal: null });
    await expect(work).rejects.toThrow("cleanup_unconfirmed");
  });
  it("separately proves partial PID retirement without claiming full cgroup resource qualification", () => {
    const partial = { ...proof, scopeKind: "cpu-private-pid-fixture" as const, cgroupRemoved: false, pidNamespaceProcessesEmpty: true, ownCpuCgroupRemoved: true };
    expect(() => assertRetirement({ code: 0, signal: null }, { proof: partial })).not.toThrow();
    expect(() => assertRetirement({ code: 0, signal: null }, { proof: { ...partial, pidNamespaceProcessesEmpty: false } })).toThrow("cleanup_unconfirmed");
  });
});
