import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { CloudRuntimeUpgradeAvailability } from "@zeros/protocol/cloud-runtime-lifecycle";

const state = vi.hoisted(() => ({ workspace: null as CloudWorkspaceDocument | null, userId: "owner", internal: false, running: false,
  availability: null as CloudRuntimeUpgradeAvailability | null }));
vi.mock("../../state/use-cached-read", () => ({ useCachedRead: (cache: unknown) => ({ data: cache === "runtime" ? state.availability : state.workspace, error: null }) }));
vi.mock("../../state/cloud-runtime-upgrade", () => ({ cloudRuntimeUpgradeAvailability: "runtime", cloudRuntimeUpgradeAvailabilityKey: () => "runtime-key",
  loadCloudRuntimeUpgradeAvailability: vi.fn(), warmCloudRuntimeUpgrade: vi.fn(), subscribeCloudRuntimeUpgradeDetails: () => () => {} }));
vi.mock("../../state/cloud-workspace-catalog", () => ({ cloudWorkspaceDetails: {}, cloudCatalogGeneration: () => 0, manageCloudWorkspace: vi.fn(), manageCloudWorkspaceRecovery: vi.fn(), refreshCloudWorkspace: vi.fn() }));
vi.mock("../../features/team/team-store", () => ({ useTeams: () => ({ me: { user: { id: state.userId } } }), getOrganizationStoreGeneration: () => 0 }));
vi.mock("../../features/settings/internal-features", () => ({ useInternalFeatureActive: () => state.internal }));
vi.mock("../../features/agent/sessions-store", async importOriginal => ({ ...await importOriginal<typeof import("../../features/agent/sessions-store")>(), useAnyChatAgentWorking: () => state.running }));
vi.mock("../../state/cloud-workspace-collaboration-cache", () => ({ warmCloudWorkspaceCollaboration: vi.fn() }));
vi.mock("../conversation/cloud-workspace-sharing-controls", () => ({ CloudWorkspaceSharingControls: () => null }));
vi.mock("../../shared/ui", () => ({ Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => createElement("button", { disabled }, children) }));
vi.mock("../../shared/ui/primitives/button", () => ({ Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => createElement("button", { disabled }, children) }));
vi.mock("../../shared/ui/primitives", () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { error: vi.fn() } }));
vi.mock("../../shared/ui/primitives/popover", () => {
  const Content = ({ children }: { children: ReactNode }) => children;
  return { Popover: Content, PopoverContent: Content, PopoverTrigger: Content };
});
import { CloudWorkspaceDetails } from "../conversation/cloud-workspace-details";

function render(folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222") {
  return renderToStaticMarkup(createElement(CloudWorkspaceDetails, { folder }));
}
beforeEach(() => {
  state.userId = "owner";
  state.internal = false;
  state.running = false;
  state.availability = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
    generation: 1, currentRuntimeId: `r1-${"a".repeat(64)}`, latestRuntimeId: `r1-${"b".repeat(64)}`, updateAvailable: true, unavailableReason: null, transition: null };
  state.workspace = {
    id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111", teamId: "team", ownerUserId: "owner",
    name: "Saved workspace", placement: "cloud", createdBy: "owner", status: "stopped", version: 1, error: null,
    createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z", deletedAt: null,
    capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "repository", revision: "main" },
    generation: { number: 1, architecture: "linux/amd64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "stopped", lastObservedAt: null },
    recovery: { state: "recovery_needed", checkpointId: "33333333-3333-4333-8333-333333333333", checkpointAt: "2026-09-29T00:00:00Z", sourceGeneration: 1, needsAcknowledgement: false },
  };
});
describe("staff runtime update controls", () => {
  it.each(["/local/workspace","/organizations/example/local-workspace"])("renders no details or runtime controls for local folder %s, even with staff enabled", folder => {
    state.internal = true;
    expect(render(folder)).toBe("");
  });
  it("shows the current runtime and automatic update notice only behind the effective staff feature gate", () => {
    expect(render()).not.toContain("Runtime ·");
    expect(render()).not.toContain("Update runtime");
    state.internal = true;
    Object.assign(state.workspace!, { status: "ready", recovery: null });
    expect(render()).toContain("Runtime ·");
    expect(render()).toContain("r1-aaaaaaaa");
    expect(render()).toContain("Updates automatically the next time this workspace wakes");
    expect(render()).not.toContain("Update runtime");
  });
  it("shows next-wake information during active work and hides the row for non-managers", () => {
    state.internal = true;
    Object.assign(state.workspace!, { status: "ready", recovery: null });
    state.availability!.unavailableReason = "cloud_workspace_busy";
    expect(render()).not.toContain("Update runtime");
    expect(render()).toContain("Updates automatically the next time this workspace wakes");
    state.workspace!.capabilities.canManage = false;
    expect(render()).not.toContain("Runtime ·");
  });
  it("retains progress on the old ready generation while its replacement drains", () => {
    state.internal = true;
    Object.assign(state.workspace!, { status: "ready", recovery: null });
    state.availability!.transition = { id: "33333333-3333-4333-8333-333333333333", generation: 2,
      runtimeId: state.availability!.latestRuntimeId!, state: "draining", error: null };
    state.availability!.unavailableReason = "cloud_generation_transition_active";
    expect(render()).toContain("Starting the cloud workspace…");
    expect(render()).not.toContain("Update available");
  });
  it("keeps next-wake information visible while a cloud turn runs", () => {
    state.internal = true;
    state.running = true;
    Object.assign(state.workspace!, { status: "ready", recovery: null });
    expect(render()).not.toContain("Update runtime");
    expect(render()).toContain("Updates automatically the next time this workspace wakes");
  });
});
describe("cloud checkpoint recovery controls", () => {
  it.each(["failed", "stopping", "stopped"])("keeps the failed setup visible while the workspace is %s", status => {
    Object.assign(state.workspace!, { status, recovery: null, setupFailure: { code: "setup_image_contract_invalid", hasLog: false } });
    const html = render();
    expect(html).toContain("Setup failed");
    expect(html).toContain("setup_image_contract_invalid");
    expect(html).toContain("The workspace image could not be verified.");
    expect(html).toContain("The failure happened before your setup script ran.");
    expect(html).not.toContain("Setup succeeded");
    expect(html).not.toContain("Setting up");
  });
  it("does not claim setup failed before the script ran when a log exists", () => {
    Object.assign(state.workspace!, { recovery: null, setupFailure: { code: "setup_command_failed", hasLog: true } });
    const html = render();
    expect(html).toContain("Setup failed");
    expect(html).toContain("setup_command_failed");
    expect(html).not.toContain("The failure happened before your setup script ran.");
  });
  it("offers recovery without a Start action on a quarantined stopped source", () => {
    const html = render();
    expect(html).toContain("Recovery needs attention");
    expect(html).toContain("Saved checkpoint");
    expect(html).toContain("<button>Recover workspace</button>");
    expect(html).not.toContain("Start workspace");
  });
  it("requires the owner and explicit acknowledgement of possible newer work", () => {
    state.userId = "another-member";
    expect(render()).toContain('<button disabled="">Recover workspace</button>');
    state.userId = "owner";
    state.workspace!.recovery!.needsAcknowledgement = true;
    expect(render()).toContain("Recovering may discard changes");
    expect(render()).toContain('<button disabled="">Recover workspace</button>');
  });
  it("shows restoration and capacity waits using the existing details", () => {
    state.workspace!.recovery!.state = "restoring";
    expect(render()).toContain("Restoring workspace from saved checkpoint");
    expect(render()).not.toContain("Recover workspace");
    state.workspace!.recovery!.state = "waiting_for_capacity";
    expect(render()).toContain("Recovery is waiting for capacity");
    expect(render()).toContain("Retry recovery");
  });
  it("keeps the ordinary Start action for a healthy stopped workspace", () => {
    state.workspace!.recovery!.state = null;
    expect(render()).toContain("Start workspace");
    expect(render()).not.toContain("Recover workspace");
  });
});
