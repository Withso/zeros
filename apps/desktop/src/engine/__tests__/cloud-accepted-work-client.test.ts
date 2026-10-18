import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestCloudAcceptedWork } from "../cloud-accepted-work-client";
import type { CloudRuntimeAuthority } from "../cloud-runtime-registration";

afterEach(() => vi.useRealTimers());
function fixture() {
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const authority = { ...scope, heartbeatToken: `zwh_${"a".repeat(43)}`, heartbeatEndpoint: "https://cp.example.test/heartbeat" } as CloudRuntimeAuthority;
  const request = { version: 1 as const, scope, acceptedWorkId: randomUUID(), commandId: randomUUID() };
  return { authority, request };
}
describe("accepted work private transport", () => {
  it("bounds a never-settling transport independently of cooperative fetch abort", async () => {
    vi.useFakeTimers(); const f = fixture();
    let outcome = "pending";
    const call = requestCloudAcceptedWork(f.authority, "close", f.request, new AbortController().signal,
      vi.fn(() => new Promise<Response>(() => {}))).then(() => { outcome = "accepted"; }, error => { outcome = error.code; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(outcome).toBe("cloud_admission_authority_timeout"); await call;
  });
  it("uses only the fixed same-origin route and refuses mismatched scopes before network", async () => {
    const f = fixture(), fetcher = vi.fn<typeof fetch>(async () => Response.json({ closed: true }));
    expect(await requestCloudAcceptedWork(f.authority, "close", f.request, new AbortController().signal, fetcher)).toEqual({ closed: true });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://cp.example.test/internal/v2/cloud-workspaces/engine/accepted-work/close");
    await expect(requestCloudAcceptedWork(f.authority, "close", { ...f.request, scope: { ...f.request.scope, organizationId: randomUUID() } },
      new AbortController().signal, fetcher)).rejects.toMatchObject({ code: "cloud_admission_authority_response_invalid" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["http://example.test/x", "https://user:secret@example.test/x"])("never sends a heartbeat credential to %s", async endpoint => {
    const f = fixture(), fetcher = vi.fn();
    await expect(requestCloudAcceptedWork({ ...f.authority, heartbeatEndpoint: endpoint }, "close", f.request,
      new AbortController().signal, fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([new Response("sensitive diagnostic", { status: 403 }), Response.json({ closed: true, credential: "private" }),
    new Response("x".repeat(1025))])("refuses diagnostic and oversized bodies without exposing content", async response => {
    const f = fixture();
    await expect(requestCloudAcceptedWork(f.authority, "close", f.request, new AbortController().signal,
      vi.fn(async () => response))).rejects.toHaveProperty("message", "Cloud agent execution authority is unavailable");
  });
});
