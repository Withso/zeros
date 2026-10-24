import { describe, expect, it, vi } from "vitest";
import { BoatCloudV2Compute } from "./boat.js";
import { BoatApiClient } from "./boat-client.js";

describe("cloud v2 Boat compute", () => {
  const client = () => ({ request: vi.fn() });

  it("renews the existing sandbox lease with a bounded TTL and never allocates another VM", async () => {
    const boat = client(), compute = new BoatCloudV2Compute(boat);
    await compute.extendLease("bx_abc12345", 86_400);
    expect(boat.request).toHaveBeenCalledExactlyOnceWith("/sandboxes/bx_abc12345", { method: "PATCH", body: { ttlSeconds: 86_400 } });
    for (const ttl of [0, -1, 1.5, NaN, 86_401]) await expect(compute.extendLease("bx_abc12345", ttl)).rejects.toThrow("Invalid Boat lease");
    expect(boat.request).toHaveBeenCalledTimes(1);
  });

  it("hosts only a protected localhost port and splits its token from the saved URL", async () => {
    const fetcher = vi.fn(async () => Response.json({ type: "sandbox.host", url: "https://fixture-41783.on.boat.dev/?_token=synthetic-port-token", access: "private", isProtected: true, localhost: true }));
    const compute = new BoatCloudV2Compute(new BoatApiClient({ apiKey: "synthetic-unused-key", timeoutMs: 1000, fetch: fetcher }));
    for (let i = 0; i < 2; i++) expect(await compute.hostPort("bx_abc12345", { port: 41783, localhost: true, title: "Zeros worker" }))
      .toEqual({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ port: 41783, localhost: true, title: "Zeros worker" });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toBe(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("idempotency-key"));
  });

  it("refuses an unprotected or foreign host URL without exposing the token in its error", async () => {
    for (const response of [
      { url: "https://fixture-41783.on.boat.dev/?_token=synthetic-port-token", access: "public", isProtected: false, localhost: true },
      { url: "https://foreign.example.test/?_token=synthetic-port-token", access: "private", isProtected: true, localhost: true },
      { url: "https://fixture-41783.on.boat.dev/", access: "private", isProtected: true, localhost: true },
    ]) {
      const boat = client(); boat.request.mockResolvedValue(response);
      await expect(new BoatCloudV2Compute(boat).hostPort("bx_abc12345", { port: 41783, localhost: true, title: "Zeros worker" })).rejects.toThrow("Invalid private worker route");
    }
  });

  it("returns from a snapshot save only once Boat can deploy it", async () => {
    const boat = client();
    boat.request.mockResolvedValueOnce({ snapshot: { status: "saving" } })
      .mockResolvedValueOnce({ snapshot: { status: "saving" } })
      .mockResolvedValueOnce({ snapshot: { status: "ready" } });
    await new BoatCloudV2Compute(boat, "default", async () => {}).saveSnapshot("bx_abc12345", "zeros-alpha-org-v1");
    expect(boat.request).toHaveBeenNthCalledWith(1, "/named-snapshots", expect.objectContaining({ method: "POST", body: { sandboxId: "bx_abc12345", name: "zeros-alpha-org-v1" } }));
    expect(boat.request).toHaveBeenNthCalledWith(3, "/named-snapshots/zeros-alpha-org-v1", { method: "GET" });
  });

  it("always submits the current disk, never an earlier save that reused the name", async () => {
    const boat = client();
    boat.request.mockImplementation(async (_path, input) => {
      if (input.method === "POST") throw Object.assign(new Error("name already exists"), { code: "snapshot_name_exists", httpStatus: 409 });
      return { snapshot: { status: "ready" } };
    });
    await expect(new BoatCloudV2Compute(boat).saveSnapshot("bx_newbuild", "zeros-alpha-org-v1")).rejects.toMatchObject({ code: "snapshot_name_exists" });
    expect(boat.request).toHaveBeenCalledExactlyOnceWith("/named-snapshots", { method: "POST", body: { sandboxId: "bx_newbuild", name: "zeros-alpha-org-v1" } });
  });

  it("reports a failed save", async () => {
    const boat = client();
    boat.request.mockResolvedValueOnce({ snapshot: { status: "saving" } }).mockResolvedValueOnce({ snapshot: { status: "failed" } });
    await expect(new BoatCloudV2Compute(boat, "default", async () => {}).saveSnapshot("bx_abc12345", "zeros-alpha-org-v1"))
      .rejects.toMatchObject({ code: "computer_snapshot_failed" });
  });
});
