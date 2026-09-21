import { describe, expect, it, vi } from "vitest";
import { BoatApiClient } from "./boat-client.js";
import { BoatRuntimeEndpointResolver } from "./boat-runtime-endpoint.js";
import type { CloudProviderOperationStore } from "./provider-operation-store.js";
const RESOURCE = "bx_23456789";
function fixture() {
  const fetcher = vi.fn<typeof fetch>();
  const get = vi.fn(async () => ({
    resourceId: RESOURCE,
    deletedAt: null,
    deletionRequestedAt: null,
  }));
  const client = new BoatApiClient({
    apiKey: "boat_test-key-not-secret",
    timeoutMs: 1000,
    fetch: fetcher,
  });
  const resolver = new BoatRuntimeEndpointResolver({
    client,
    operations: { get } as unknown as CloudProviderOperationStore,
    enginePort: 39393,
  });
  const route = {
    ok: true,
    success: true,
    port: 39393,
    access: "public",
    isProtected: false,
    url: "https://swift-otter-39393.on.boat.dev",
  };
  const ready = () =>
    fetcher.mockResolvedValueOnce(
      Response.json({
        ok: true,
        sandbox: { id: RESOURCE, state: "ready", subdomain: "swift-otter" },
      }),
    );
  return { fetcher, get, resolver, route, ready };
}
describe("Boat Zeros runtime endpoint", () => {
  it("exposes only the authenticated engine port and forwards the caller's Zeros capability", async () => {
    const f = fixture();
    f.ready();
    f.fetcher.mockResolvedValueOnce(Response.json(f.route));
    const credential = `zwp_${"A".repeat(43)}`;
    expect(
      await f.resolver.preview(RESOURCE, 3000, {
        grantId: "grant-id",
        credential,
      }),
    ).toEqual({
      url: `${f.route.url}/`,
      headerName: "x-zeros-runtime-access",
      headerValue: credential,
    });
    expect(f.fetcher.mock.calls[1][0]).toBe(
      `https://boat.dev/api/v1/sandboxes/${RESOURCE}/host`,
    );
    expect(JSON.parse(String(f.fetcher.mock.calls[1][1]!.body))).toEqual({
      port: 39393,
      public: true,
    });
    expect(JSON.stringify(f.fetcher.mock.calls)).not.toContain(credential);
  });
  it("rejects unknown ownership, pending deletion, absent user capability and internal ports before hosting", async () => {
    const f = fixture();
    for (const port of [22, 22222, 39393, 65536, 3.5]) {
      await expect(
        f.resolver.preview(RESOURCE, port, {
          grantId: "grant",
          credential: `zwp_${"A".repeat(43)}`,
        }),
      ).rejects.toThrow();
    }
    await expect(f.resolver.preview(RESOURCE, 3000)).rejects.toThrow();
    f.get.mockResolvedValueOnce(null as never);
    await expect(f.resolver.bridge(RESOURCE)).rejects.toThrow();
    f.get.mockResolvedValueOnce({
      resourceId: RESOURCE,
      deletionRequestedAt: new Date(),
      deletedAt: null,
    } as never);
    await expect(f.resolver.bridge(RESOURCE)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { url: "https://attacker.example/" },
    { url: "https://other-39393.on.boat.dev" },
    { url: "https://swift-otter-3000.on.boat.dev" },
    { url: "https://swift-otter-39393.on.boat.dev?_token=secret" },
    { isProtected: true },
    { access: "private" },
    { port: 3000 },
  ])(
    "rejects untrusted or credential-bearing provider route responses %j",
    async (change) => {
      const f = fixture();
      f.ready();
      f.fetcher.mockResolvedValueOnce(Response.json({ ...f.route, ...change }));
      await expect(f.resolver.bridge(RESOURCE)).rejects.toMatchObject({
        code: "provider_access_response_invalid",
      });
    },
  );
});
