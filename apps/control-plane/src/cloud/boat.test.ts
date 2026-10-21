import { describe, expect, it, vi } from "vitest";
import { BoatCloudV2Compute } from "./boat.js";

describe("cloud v2 Boat compute", () => {
  const client = () => ({ request: vi.fn() });

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
