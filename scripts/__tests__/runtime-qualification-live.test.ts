import { describe, expect, it, vi } from "vitest";
import { parseRunbookSelection, qualificationEvidence, verifyLiveQualification, runbookDiagnostic } from "../cloud-workspace-validation/runtime-qualification-live.mjs";

const runtimeId = "r1-" + "a".repeat(64);
const runId = "11111111-1111-4111-8111-111111111111";
const baseCompatibilityId = "bc1-" + "b".repeat(64);
function status(state = "succeeded") {
  return { channel: "alpha", qualificationRuns: [{ runId, runtimeId, state, baseImageId: "zeros-v2-test-base",
    baseCompatibilityId, sandboxId: "bx_23456789", cleanupConfirmedAt: state === "succeeded" ? "2026-10-04T12:00:00Z" : null,
    finishedAt: state === "succeeded" ? "2026-10-04T12:00:00Z" : null, diagnostic: { ok: state === "succeeded", privateValue: "never-echo" } }],
    qualifications: ["claude-setup-token", "codex-chatgpt", "cursor-api-key", "claude-api-key", "codex-api-key"].map(credentialKind => ({
      runtimeId, baseCompatibilityId, credentialKind, profile: "zeros-cloud-worker-v4", enabled: true,
      revokedAt: null, evidenceMode: "smoke", mcpQualified: false,
    })) };
}
describe("Alpha runtime smoke operator runbook", () => {
  it("accepts only explicit runtime or run identities and closed failures", () => {
    expect(parseRunbookSelection(["--runtime", runtimeId])).toEqual({ runtimeId });
    expect(parseRunbookSelection(["--run", runId])).toEqual({ runId });
    expect(() => parseRunbookSelection(["--runtime", "private-value"])).toThrow();
    expect(runbookDiagnostic(new Error("never-echo")).failedChecks).toEqual(["http_status"]);
  });
  it("checks Alpha before any allocation and never reports raw responses", async () => {
    const request = vi.fn(async () => ({ ...status(), channel: "beta" }));
    const error = await verifyLiveQualification({ runtimeId }, { request, save: vi.fn() }).catch((value: unknown) => value);
    expect(runbookDiagnostic(error).failedChecks).toEqual(["alpha_only"]);
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.stringify(qualificationEvidence(status(), runId))).not.toContain("never-echo");
  });
  it("records allocation receipts before polling, then requires cleanup and all five approvals", async () => {
    const request = vi.fn().mockResolvedValueOnce(status("queued"))
      .mockResolvedValueOnce({ runId, runtimeId, status: "queued" })
      .mockResolvedValueOnce(status("running")).mockResolvedValueOnce(status());
    const save = vi.fn(), wait = vi.fn(async () => {});
    expect((await verifyLiveQualification({ runtimeId }, { request, save, wait })).approvedKinds).toHaveLength(5);
    expect(request.mock.calls.filter(([, method]) => method === "POST")).toHaveLength(1);
    expect(save.mock.calls[0][0]).toMatchObject({ runId, state: "queued", cleanupConfirmedAt: null });
    expect(save.mock.calls.at(-1)![0]).toMatchObject({ sandboxId: "bx_23456789", state: "succeeded", cleanupConfirmedAt: expect.any(String) });
  });
  it.each(["cleanup", "approvals", "mcp", "failure"])("rejects unproved success for %s", async missing => {
    const value = status();
    if (missing === "cleanup") value.qualificationRuns[0].cleanupConfirmedAt = null;
    if (missing === "approvals") value.qualifications.pop();
    if (missing === "mcp") value.qualifications[0].mcpQualified = true;
    if (missing === "failure") value.qualificationRuns[0].state = "failed";
    await expect(verifyLiveQualification({ runId }, { request: async () => value, save: vi.fn() })).rejects.toThrow();
  });
  it("resumes without allocation and leaves cleanup unconfirmed when observation expires", async () => {
    let now = 0;
    const request = vi.fn(async () => status("running")), save = vi.fn();
    const error = await verifyLiveQualification({ runId }, { request, save, now: () => now,
      wait: async (ms: number) => { now += ms; }, timeoutMs: 1000 }).catch((value: unknown) => value);
    expect(runbookDiagnostic(error)).toMatchObject({ timedOut: true, failedChecks: ["timeout"] });
    expect(request.mock.calls.every(call => call.length === 1)).toBe(true);
    expect(save.mock.calls.at(-1)![0].cleanupConfirmedAt).toBeNull();
  });
});
