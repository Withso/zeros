import { describe, expect, it, vi } from "vitest";
import { requestCloudCommand, requestCloudAction } from "../cloud-command-client";
import { randomUUID } from "node:crypto";
const authority = { heartbeatEndpoint: "https://control.example.test/internal/v1/cloud-workspaces/engine/heartbeat",
  heartbeatToken: "fixture-private-heartbeat", workspaceId: "workspace", organizationId: "organization", generation: 3, engineInstanceId: "engine" };
describe("cloud command HTTP boundary", () => {
  it("declares turn support and keeps settlement compatible until the control plane acknowledges it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ result: null }));
    const commandId = randomUUID(), terminal = { commandId, conversationId: "chat", executionId: "execution", turnId: "turn", agentId: "claude",
      status: "completed" as const, stopReason: "end_turn" as const, response: { stopReason: "end_turn" as const } };
    const settle = { kind: "settle" as const, result: { commandId, claimId: randomUUID(), state: "succeeded" as const, resultCode: null,
      result: { version: 1 as const, model: "model", terminal } } };
    const signal = new AbortController().signal;
    await requestCloudCommand(authority, settle, signal, fetcher);
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ "x-zeros-native-commands": "1", "x-zeros-cloud-turn-protocol": "1" });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).request.result.result).toEqual({ version: 1, model: "model" });
    fetcher.mockImplementationOnce(async () => Response.json({ result: null }, { headers: { "x-zeros-cloud-turn-protocol": "1" } }));
    await requestCloudCommand(authority, { kind: "snapshot", conversationId: "chat" }, signal, fetcher);
    await requestCloudCommand(authority, settle, signal, fetcher);
    expect(JSON.parse(String(fetcher.mock.calls[2]![1]?.body)).request.result.result.terminal).toEqual(terminal);
    expect(settle.result.result.terminal).toEqual(terminal);
    // The server may be replaced with an older deployment; a missing response
    // acknowledgement immediately removes the additive field on later writes.
    await requestCloudCommand(authority, settle, signal, fetcher);
    expect(JSON.parse(String(fetcher.mock.calls[3]![1]?.body)).request.result.result).toEqual({ version: 1, model: "model" });
  });
  it("uses the same engine-only authority for action receipts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: null }));
    await requestCloudAction(authority, { kind: "read", operationId: "fixture" }, new AbortController().signal, fetcher);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://control.example.test/internal/v1/cloud-workspaces/engine/actions");
    expect(init?.headers).toMatchObject({ authorization: "Bearer fixture-private-heartbeat" });
    expect(init?.headers).not.toHaveProperty("x-zeros-claude-preferences");
    expect(init?.redirect).toBe("error");
  });
  it("uses only the registered control origin and scopes authority outside the untrusted request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ result: null }));
    const request = { kind: "snapshot" as const, conversationId: "chat" };
    expect(await requestCloudCommand(authority, request, new AbortController().signal, fetcher)).toBeNull();
    const [endpoint, init] = fetcher.mock.calls[0]!;
    expect(String(endpoint)).toBe("https://control.example.test/internal/v1/cloud-workspaces/engine/commands");
    expect(init?.headers).toHaveProperty("x-zeros-claude-preferences", "1");
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
