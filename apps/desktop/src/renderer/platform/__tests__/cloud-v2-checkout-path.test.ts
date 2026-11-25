import { describe, expect, it } from "vitest";
import { cloudV2CheckoutPath, cloudV2Document, type CloudV2Workspace } from "../cloud-v2";

describe("cloud v2 checkout path", () => {
  it("matches the control plane's native checkout for the workspace repository", () => {
    const workspace = {
      id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
      creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w", repository: "Withso/zeros",
      branch: "zeros/w", baseBranch: "main", state: "stopped", errorCode: null, archivedAt: null,
      createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", version: 2,
      capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
    } satisfies CloudV2Workspace;
    expect(cloudV2CheckoutPath(cloudV2Document(workspace))).toBe("/home/user/Withso/zeros");
  });

  it("explains a workspace whose computer no longer exists", () => {
    const workspace = {
      id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
      creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w", repository: "Withso/zeros",
      branch: "zeros/w", baseBranch: "main", state: "failed", errorCode: "sandbox_missing", archivedAt: null,
      createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", version: 2,
      capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
    } satisfies CloudV2Workspace;
    expect(cloudV2Document(workspace).error).toEqual({ code: "sandbox_missing",
      message: "This workspace's computer no longer exists. Delete it and create a new one." });
    expect(cloudV2Document(workspace).capabilities).toMatchObject({ canStart: false, startUnavailableReason: "This workspace failed. Create a new one." });
  });

  it("lets Start recover a workspace the server marks recoverable, and keeps Delete-only for a create that never ran", () => {
    const failed = (errorCode: string, recoverable?: true) => ({
      id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
      creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w", repository: "Withso/zeros",
      branch: "zeros/w", baseBranch: "main", state: "failed", errorCode, archivedAt: null,
      createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", version: 2,
      capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
      ...(recoverable ? { recoverable } : {}),
    } satisfies CloudV2Workspace);
    const woke = cloudV2Document(failed("worker_boot_timeout", true));
    expect(woke.capabilities).toMatchObject({ canStart: true, startUnavailableReason: null, recoverable: true });
    expect(woke.error).toEqual({ code: "worker_boot_timeout", message: "The workspace computer did not start in time. Start it to try again." });
    const route = cloudV2Document(failed("provider_route_invalid", true));
    expect(route.capabilities).toMatchObject({ canStart: true });
    expect(route.error?.message).toBe("This workspace couldn't start. Start it to try again.");
    // Without the server's mark (a create that timed out, or an older server), Delete stays the way forward.
    const created = cloudV2Document(failed("worker_boot_timeout"));
    expect(created.capabilities).toMatchObject({ canStart: false, startUnavailableReason: "This workspace failed. Create a new one." });
    expect(created.capabilities).not.toHaveProperty("recoverable");
    expect(created.error?.message).toBe("The workspace computer did not start in time. Delete it and create a new one.");
    // A malformed mark is ignored, never read as consent to start.
    expect(cloudV2Document({ ...failed("worker_boot_timeout"), recoverable: "yes" } as CloudV2Workspace).capabilities.canStart).toBe(false);
    // A restore failure the desktop already retries keeps its own copy and its wake, unless the server marks it.
    expect(cloudV2Document(failed("checkpoint_restore_failed")).capabilities).not.toHaveProperty("recoverable");
  });

  it("lets Start retry a failed checkpoint restore, but not a damaged checkpoint", () => {
    const failed = (errorCode: string) => ({
      id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
      creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w", repository: "Withso/zeros",
      branch: "zeros/w", baseBranch: "main", state: "failed", errorCode, archivedAt: null,
      createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", version: 2,
      capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
    } satisfies CloudV2Workspace);
    for (const code of ["checkpoint_restore_failed", "checkpoint_download_failed", "checkpoint_prerequisites_missing", "checkpoint_repository_missing"]) {
      const document = cloudV2Document(failed(code));
      expect(document.capabilities).toMatchObject({ canStart: true, startUnavailableReason: null });
      expect(document.error?.message).toMatch(/Start it to try again\.$/);
    }
    const damaged = cloudV2Document(failed("checkpoint_corrupt"));
    expect(damaged.capabilities).toMatchObject({ canStart: false, startUnavailableReason: "This workspace failed. Create a new one." });
    expect(damaged.error?.message).toBe("This workspace's last checkpoint is damaged and cannot be restored.");
    const checkout = cloudV2Document(failed("cloud_source_checkout_failed"));
    expect(checkout.status).toBe("failed");
    expect(checkout.capabilities).toMatchObject({ canStart: false });
    expect(checkout.error).toEqual({ code: "cloud_source_checkout_failed",
      message: "The repository or base branch could not be checked out. Existing files were retained. Check repository access and the base branch before creating a new workspace." });
  });

  it.each([
    ["cloud_environment_path_conflict", /existing file/i],
    ["cloud_environment_path_untracked_required", /untracked/i],
    ["cloud_environment_path_ignored_required", /ignored by Git/i],
    ["cloud_environment_seed_uncertain", /safely/i],
    ["cloud_environment_pin_changed", /saved environment/i],
    ["cloud_environment_runtime_required", /runtime/i],
  ])("gives recovery guidance for %s without retrying a refused seed", (errorCode, explanation) => {
    const document = cloudV2Document({
      id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111",
      creatorUserId: "33333333-3333-4333-8333-333333333333", name: "w", repository: "example/fixture",
      branch: "zeros/w", baseBranch: "main", state: "failed", errorCode, archivedAt: null,
      createdAt: "2026-10-22T00:00:00Z", updatedAt: "2026-10-22T00:00:00Z", version: 2,
      capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] },
    });
    expect(document.capabilities.canStart).toBe(false);
    expect(document.error?.message).toMatch(explanation);
    expect(document.error?.message).toMatch(/new workspace/i);
  });
});
