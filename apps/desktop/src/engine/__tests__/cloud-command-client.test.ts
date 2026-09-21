import { describe, expect, it, vi } from "vitest";
import { requestCloudCommand, requestCloudAction } from "../cloud-command-client";
const authority = { heartbeatEndpoint: "https://control.example.test/internal/v1/cloud-workspaces/engine/heartbeat",
  heartbeatToken: "fixture-private-heartbeat", workspaceId: "workspace", organizationId: "organization", generation: 3, engineInstanceId: "engine" };
describe("cloud command HTTP boundary", () => {
  it("uses the same engine-only authority for action receipts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: null }));
    await requestCloudAction(authority, { kind: "read", operationId: "fixture" }, new AbortController().signal, fetcher);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://control.example.test/internal/v1/cloud-workspaces/engine/actions");
    expect(init?.headers).toMatchObject({ authorization: "Bearer fixture-private-heartbeat" });
    expect(init?.redirect).toBe("error");
  });
  it("uses only the registered control origin and scopes authority outside the untrusted request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: null }));
    const request = { kind: "snapshot" as const, conversationId: "chat" };
    expect(await requestCloudCommand(authority, request, new AbortController().signal, fetcher)).toBeNull();
    const [endpoint, init] = fetcher.mock.calls[0]!;
    expect(String(endpoint)).toBe("https://control.example.test/internal/v1/cloud-workspaces/engine/commands");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ authorization: "Bearer fixture-private-heartbeat" });
    expect(JSON.parse(String(init?.body))).toEqual({ workspaceId: "workspace", organizationId: "organization", generation: 3, engineInstanceId: "engine", request });
  });
  it("returns a stable revision conflict without echoing driver or prompt text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "command_conflict", detail: "private prompt" }, { status: 409 }));
    await expect(requestCloudCommand(authority, { kind: "snapshot", conversationId: "chat" }, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ message: "command_conflict", code: "command_conflict" });
  });
  it("bounds streamed responses even when Content-Length is absent", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(requestCloudCommand(authority, { kind: "snapshot", conversationId: "chat" }, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ code: "command_response_invalid" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
