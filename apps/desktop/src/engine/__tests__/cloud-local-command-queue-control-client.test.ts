import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { requestCloudCredentialControls } from "../cloud-local-command-queue-control-client";
const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
const authority = { ...scope, heartbeatEndpoint: "https://control.test/internal/v1/cloud-workspaces/engine/heartbeat",
  heartbeatToken: `zwh_${"a".repeat(43)}` };
const input = { ...scope, version: 1 as const, mode: "boot-owner-v1" as const, bootId: randomUUID(), writerEpoch: randomUUID(), acknowledgements: [] };
const result = { version: 1, mode: "boot-owner-v1", controls: [] };
describe("private credential control transport", () => {
  it("refuses an insecure private origin before sending engine authority", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(requestCloudCredentialControls({ ...authority, heartbeatEndpoint: "http://control.test/heartbeat" },
      input, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: "credential_control_authority_rejected" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses only the authenticated fixed endpoint and closed exchange body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result }));
    await expect(requestCloudCredentialControls(authority, input, new AbortController().signal, fetcher)).resolves.toEqual(result);
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://control.test/internal/v2/cloud-workspaces/engine/agent-credential-controls");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual(input);
    await expect(requestCloudCredentialControls(authority, { ...input, workspaceId: randomUUID() }, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ code: "credential_control_authority_rejected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 408, 429, 503])("keeps status%s distinct from confirmed authority loss", async status => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ privateError: "do-not-reflect" }, { status }));
    await expect(requestCloudCredentialControls(authority, input, new AbortController().signal, fetcher)).rejects.toMatchObject({
      code: status === 401 || status === 403 ? "credential_control_authority_rejected" : "credential_control_storage_unavailable" });
  });
  it.each(["before-dispatch", "during-fetch", "during-body", "after-body"] as const)("does not turn local cancellation %s into authority rejection", async point => {
    const controller = new AbortController();
    if (point === "before-dispatch") controller.abort();
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (point === "during-fetch") { controller.abort(); throw new DOMException("synthetic cancellation", "AbortError"); }
      return new Response(new ReadableStream({ start(stream) {
        if (point === "during-body") { controller.abort(); stream.error(new DOMException("synthetic body cancellation", "AbortError")); return; }
        stream.enqueue(new TextEncoder().encode(JSON.stringify({ result }))); controller.abort(); stream.close();
      } }), { headers: { "content-type": "application/json" } });
    });
    await expect(requestCloudCredentialControls(authority, input, controller.signal, fetcher))
      .rejects.toMatchObject({ code: "credential_control_cancelled" });
    expect(fetcher).toHaveBeenCalledTimes(point === "before-dispatch" ? 0 : 1);
  });
  it("validates the fixed origin and requested identity before local cancellation", async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn<typeof fetch>();
    await expect(requestCloudCredentialControls(authority, { ...input, engineInstanceId: randomUUID() }, controller.signal, fetcher))
      .rejects.toMatchObject({ code: "credential_control_authority_rejected" });
    await expect(requestCloudCredentialControls({ ...authority, heartbeatEndpoint: "http://control.test/heartbeat" }, input, controller.signal, fetcher))
      .rejects.toMatchObject({ code: "credential_control_authority_rejected" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([401, 403])("keeps explicit status%s terminal even during local cancellation", async status => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => { controller.abort(); return new Response(null, { status }); });
    await expect(requestCloudCredentialControls(authority, input, controller.signal, fetcher))
      .rejects.toMatchObject({ code: "credential_control_authority_rejected" });
  });
  it("keeps a foreign control terminal even when the local request is cancelled", async () => {
    const controller = new AbortController();
    const control = { ...input, fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1,
      engineInstanceId: randomUUID(), mutationId: randomUUID(), controlRequestId: randomUUID(), fenceEpoch: 1,
      selectors: [{ provider: "cursor", credentialId: randomUUID() }], operation: "pause-starts", desiredCacheRevision: null };
    const { acknowledgements: _acks, mode: _mode, ...foreign } = control;
    const fetcher = vi.fn<typeof fetch>(async () => { controller.abort(); return Response.json({ result: { ...result, controls: [foreign] } }); });
    await expect(requestCloudCredentialControls(authority, input, controller.signal, fetcher))
      .rejects.toMatchObject({ code: "credential_control_authority_rejected" });
  });
  it.each([{ result: { ...result, injected: true } }, { result, privateError: "must-not-reflect" },
    { result: { ...result, controls: [{ operation: "release" }] } }])("rejects malformed controls without changing a fence", async body => {
    await expect(requestCloudCredentialControls(authority, input, new AbortController().signal, async () => Response.json(body)))
      .rejects.toMatchObject({ code: "credential_control_storage_unavailable" });
  });
});
