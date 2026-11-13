import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../workspace-runtime-client";
import { cloudScopedId } from "../cloud-workspace-key";
import { ControlPlaneError } from "../../../features/team/control-plane";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chatId = cloudScopedId(target, "native-chat");
const request = { type: "WORKSPACE_REQUEST" as const, op: "messages.window", params: { chatId, limit: 50 } };
const page = (text: string) => ({ messages: [{ msgId: "m1", kind: "text", payload: JSON.stringify({ text }), createdAt: 1 }] });

type ReadHistory = NonNullable<ConstructorParameters<typeof WorkspaceRuntimeClient>[0]["readHistory"]>;
function stopped(readHistory: ReturnType<typeof vi.fn>) {
  const open = vi.fn(async () => { throw new Error("VM must stay stopped"); });
  return new WorkspaceRuntimeClient({ open, readHistory: readHistory as unknown as ReadHistory, historyRoot: () => "/home/user/Owner/repo", workspaces: () => [] });
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(1); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("§14.5: a temporary GitHub verification failure on a history read", () => {
  it.each([
    new ControlPlaneError(503, "github_unavailable", "GitHub access verification is temporarily unavailable."),
    new ControlPlaneError(503, "github_verification_busy", "Busy"),
    new ControlPlaneError(429, "github_rate_limited", "Limited"),
  ])("keeps the cached transcript and retries quietly: %s", async failure => {
    const readHistory = vi.fn().mockResolvedValueOnce(page("cached")).mockRejectedValueOnce(failure).mockResolvedValue(page("fresh"));
    const client = stopped(readHistory);
    try {
      expect(await client.request(request)).toMatchObject({ result: page("cached") });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await client.request(request)).toMatchObject({ result: page("cached") });
      expect(readHistory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(29_999); expect(readHistory).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1); expect(readHistory).toHaveBeenCalledTimes(3);
      expect(await client.request(request)).toMatchObject({ result: page("fresh") });
    } finally { client.dispose(); }
  });

  it("still fails when there is no cached transcript, and never hides a permanent refusal", async () => {
    for (const failure of [new ControlPlaneError(503, "github_unavailable", "Unavailable"), new ControlPlaneError(403, "github_authorization_required", "Refused")]) {
      const readHistory = vi.fn().mockRejectedValue(failure);
      const client = stopped(readHistory);
      try { await expect(client.request(request)).rejects.toBe(failure); } finally { client.dispose(); }
    }
    const refused = new ControlPlaneError(403, "github_authorization_required", "Refused");
    const readHistory = vi.fn().mockResolvedValueOnce(page("cached")).mockRejectedValue(refused);
    const client = stopped(readHistory);
    try {
      await client.request(request); await vi.advanceTimersByTimeAsync(2_000);
      await expect(client.request(request)).rejects.toBe(refused);
    } finally { client.dispose(); }
  });

  it("schedules one quiet retry per read and none after dispose", async () => {
    const failure = new ControlPlaneError(503, "github_unavailable", "Unavailable");
    const readHistory = vi.fn().mockResolvedValueOnce(page("cached")).mockRejectedValue(failure);
    const client = stopped(readHistory);
    await client.request(request); await vi.advanceTimersByTimeAsync(2_000);
    await client.request(request); await vi.advanceTimersByTimeAsync(2_000);
    await client.request(request);
    const calls = readHistory.mock.calls.length;
    client.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(readHistory).toHaveBeenCalledTimes(calls);
  });
});
