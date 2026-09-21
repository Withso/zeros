import { describe, expect, it, vi } from "vitest";
import { requestCloudEvent } from "../cloud-event-client";
import type { CloudRuntimeAuthority } from "../cloud-runtime-registration";

const authority: CloudRuntimeAuthority = { workspaceId: "workspace", organizationId: "organization", generation: 1,
  engineInstanceId: "engine", heartbeatEndpoint: "https://control.example.test/internal/heartbeat", heartbeatToken: "fixture-secret" };
const request = { kind: "replay" as const, streamId: "engine", after: 0 };
describe("bounded cloud event HTTP client", () => {
  it("binds credentials to the configured control plane without redirecting", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ result: { events: [] } }));
    expect(await requestCloudEvent(authority, request, new AbortController().signal, fetcher)).toEqual({ events: [] });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://control.example.test/internal/v1/cloud-workspaces/engine/events");
    expect(init.redirect).toBe("error"); expect(init.headers.authorization).toBe("Bearer fixture-secret");
    expect(JSON.parse(init.body)).not.toHaveProperty("heartbeatToken");
  });
  it.each([
    [Response.json({ error: "event_cursor_expired" }, { status: 409 }), "event_cursor_expired"],
    [Response.json({ error: "private backend failure" }, { status: 500 }), "event_service_unavailable"],
    [new Response("x".repeat(2 * 1024 * 1024 + 1)), "event_response_invalid"],
    [new Response("{broken"), "event_response_invalid"],
    [Response.json({ result: {}, leaked: "unexpected" }), "event_response_invalid"],
  ])("rejects malformed or oversized responses and exposes only stable errors", async (response, code) => {
    await expect(requestCloudEvent(authority, request, new AbortController().signal, vi.fn().mockResolvedValue(response)))
      .rejects.toMatchObject({ code });
  });
});
