import { describe, expect, it, vi } from "vitest";
import { BoatCloudV2Compute } from "./boat.js";
import { BoatApiClient } from "./boat-client.js";

describe("cloud v2 Boat compute", () => {
  const client = () => ({ request: vi.fn() });

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

  it("reports a failed save", async () => {
    const boat = client();
    boat.request.mockResolvedValueOnce({ snapshot: { status: "saving" } }).mockResolvedValueOnce({ snapshot: { status: "failed" } });
    await expect(new BoatCloudV2Compute(boat, "default", async () => {}).saveSnapshot("bx_abc12345", "zeros-alpha-org-v1"))
      .rejects.toMatchObject({ code: "computer_snapshot_failed" });
  });
});
