import { describe, expect, it, vi } from "vitest";
import { releaseCanaryAdapter } from "./worker-canary";
import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";

const image = { snapshotId: "retired-worker", sourceCommit: "a".repeat(40), buildSha256: "b".repeat(64),
  architecture: "linux/amd64" as const, storageMiB: 4096 };

describe("retired canary allocation and historical recovery", () => {
  it.each(["allocating", "starting", "running", "completed"])("refuses reentry at %s without allocating or changing retained history", async phase => {
    const job = { id: "historical-canary", phase, image }, run = { canaries: [job] }, before = structuredClone(run);
    const lease = { state: { resources: { images: [] } }, save: vi.fn(), fence: vi.fn() };
    const core = { allocate: vi.fn(), ready: vi.fn(), start: vi.fn(), poll: vi.fn(), retire: vi.fn() };
    await expect(releaseCanaryAdapter(lease, run, new Map(), core).qualify(image, "claude-setup-token"))
      .rejects.toThrow(RELEASE_WORKER_IMAGES_RETIRED);
    expect(run).toEqual(before); expect(lease.save).not.toHaveBeenCalled();
    for (const action of Object.values(core)) expect(action).not.toHaveBeenCalled();
  });
  it("keeps explicit cleanup of a pre-dispatch allocation available without native execution", async () => {
    const job = { id: "historical-canary", phase: "allocating", retired: false }, run = { canaries: [job] };
    const lease = { state: { resources: { images: [] } }, save: vi.fn(), fence: vi.fn() };
    const core = { retire: vi.fn(async () => {}), allocate: vi.fn(), start: vi.fn() };
    expect(await releaseCanaryAdapter(lease, run, new Map(), core).cleanup()).toBe(true);
    expect(core.retire).toHaveBeenCalledWith(job); expect(job.retired).toBe(true);
    expect(core.allocate).not.toHaveBeenCalled(); expect(core.start).not.toHaveBeenCalled();
  });
});
