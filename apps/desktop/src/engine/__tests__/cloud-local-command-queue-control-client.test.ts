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
  it.each([{ result: { ...result, injected: true } }, { result, privateError: "must-not-reflect" },
    { result: { ...result, controls: [{ operation: "release" }] } }])("rejects malformed controls without changing a fence", async body => {
    await expect(requestCloudCredentialControls(authority, input, new AbortController().signal, async () => Response.json(body)))
      .rejects.toMatchObject({ code: "credential_control_storage_unavailable" });
  });
});
