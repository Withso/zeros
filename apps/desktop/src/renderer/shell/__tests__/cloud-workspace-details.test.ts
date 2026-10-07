import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { Me, OrganizationSummary } from "../../features/team/control-plane";
import type { CloudRuntimeUpgradeAvailability } from "@zeros/protocol/cloud-runtime-lifecycle";

const state = vi.hoisted(() => ({ workspace: null as CloudWorkspaceDocument | null, userId: "owner" as string | null, cloudEntitled: true, running: false,
  runtimeReads: [] as boolean[], usageReads: [] as boolean[], availability: null as CloudRuntimeUpgradeAvailability | null }));
vi.mock("../../state/use-cached-read", () => ({ useCachedRead: (cache: unknown, key: string | null, _read: unknown, options: { enabled?: boolean }) => {
  if (cache === "runtime") state.runtimeReads.push(!!key && !!options.enabled);
  return { data: cache === "runtime" ? state.availability : state.workspace, error: null };
} }));
vi.mock("../../state/use-cloud-workspace-resource-usage", () => ({ useCloudWorkspaceResourceUsage: (_key: string | null, options: { featureActive: boolean }) => {
  state.usageReads.push(options.featureActive);
  return { data: null };
} }));
vi.mock("../../state/use-cloud-workspace-detected-ports", () => ({ useCloudWorkspaceDetectedPorts: () => ({ data: null }) }));
vi.mock("../conversation/cloud-workspace-restart-controls", () => ({ CloudWorkspaceStatusRow: () => null }));
vi.mock("../../state/cloud-runtime-upgrade", () => ({ cloudRuntimeUpgradeAvailability: "runtime", cloudRuntimeUpgradeAvailabilityKey: () => "runtime-key",
  loadCloudRuntimeUpgradeAvailability: vi.fn(), warmCloudRuntimeUpgrade: vi.fn(), subscribeCloudRuntimeUpgradeDetails: () => () => {} }));
vi.mock("../../state/cloud-workspace-catalog", () => ({ cloudWorkspaceDetails: {}, cloudCatalogGeneration: () => 0,
  subscribeCloudWorkspaces: () => () => {}, canReadCloudWorkspace: () => true,
  cloudWorkspaceDocument: () => state.workspace, acceptCloudWorkspaceDocument: vi.fn(),
  manageCloudWorkspace: vi.fn(), manageCloudWorkspaceRecovery: vi.fn(), refreshCloudWorkspace: vi.fn() }));
function accountSnapshot(): Me | null {
  if (!state.userId) return null;
  const organizations = [
    { id: "11111111-1111-4111-8111-111111111111", isPersonal: false, role: "member",
      workspaceCapabilities: { local: true, cloud: state.cloudEntitled } },
    { id: "99999999-9999-4999-8999-999999999999", isPersonal: false, role: "member",
      workspaceCapabilities: { local: true, cloud: true } },
  ] as OrganizationSummary[];
  return {
    user: { id: state.userId, email: "fixture@example.test", displayName: null, staffRole: null },
    organizations, teams: organizations,
  };
}
vi.mock("../../features/team/team-store", () => ({
  useTeams: () => ({ me: accountSnapshot() }), getTeamStoreState: () => ({ me: accountSnapshot() }),
  getOrganizationStoreGeneration: () => 0,
}));
vi.mock("../../features/agent/sessions-store", async importOriginal => ({ ...await importOriginal<typeof import("../../features/agent/sessions-store")>(), useAnyChatAgentWorking: () => state.running }));
vi.mock("../../state/cloud-workspace-collaboration-cache", () => ({ warmCloudWorkspaceCollaboration: vi.fn() }));
vi.mock("../../shared/ui", () => ({ Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => createElement("button", { disabled }, children) }));
vi.mock("../../shared/ui/primitives/button", async importOriginal => ({ ...await importOriginal<typeof import("../../shared/ui/primitives/button")>(),
  Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => createElement("button", { disabled }, children) }));
vi.mock("../../shared/ui/primitives", async importOriginal => ({
  ...await importOriginal<typeof import("../../shared/ui/primitives")>(), Tooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { error: vi.fn() } }));
vi.mock("../../shared/ui/primitives/popover", () => {
  const Content = ({ children }: { children: ReactNode }) => children;
  return { Popover: Content, PopoverContent: Content, PopoverTrigger: Content };
});
import { CloudWorkspaceDetails } from "../conversation/cloud-workspace-details";
import { CloudWorkspaceRuntimeControls } from "../conversation/cloud-workspace-runtime-controls";

function render(folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222") {
  return renderToStaticMarkup(createElement(CloudWorkspaceDetails, { folder }));
}
beforeEach(() => {
  state.userId = "owner";
  state.cloudEntitled = true;
  state.running = false;
  state.runtimeReads = [];
  state.usageReads = [];
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
describe("authorized runtime update controls", () => {
  const renderRuntime = () => renderToStaticMarkup(createElement(CloudWorkspaceRuntimeControls, { workspace: state.workspace!, active: true }));
  it.each(["/local/workspace","/organizations/example/local-workspace"])("renders no details or runtime controls for local folder %s, with Cloud account access", folder => {
    state.cloudEntitled = true;
    expect(render(folder)).toBe("");
  });
  it.each(["signed out", "target entitlement revoked"])("keeps native and runtime controls inert when %s despite retained manager capabilities", reason => {
    if (reason === "signed out") state.userId = null;
    else state.cloudEntitled = false;
    const html = render();
    expect(html).not.toContain("More workspace actions");
    expect(html).not.toContain("Open in Terminal");
    expect(renderRuntime()).toBe("");
    expect(state.runtimeReads.every(enabled => !enabled)).toBe(true);
    expect(state.usageReads.every(enabled => !enabled)).toBe(true);
  });
  it("keeps runtime IDs out of details and gates next-wake information in More", () => {
    expect(render()).not.toContain("Runtime ·");
    expect(render()).not.toContain("Update runtime");
    state.cloudEntitled = true;
    Object.assign(state.workspace!, { status: "ready", recovery: null });
    expect(render()).not.toContain("r1-aaaaaaaa");
    expect(render()).not.toContain("Updates automatically the next time this workspace wakes");
    expect(renderRuntime()).toContain("Updates automatically the next time this workspace wakes");
    expect(render()).not.toContain("Update runtime");
  });
  it("shows next-wake information during active work and hides the row for non-managers", () => {
    state.cloudEntitled = true;
    Object.assign(state.workspace!, { status: "ready", recovery: null });
    state.availability!.unavailableReason = "cloud_workspace_busy";
    expect(render()).not.toContain("Update runtime");
    expect(renderRuntime()).toContain("Updates automatically the next time this workspace wakes");
    state.workspace!.capabilities.canManage = false;
    expect(renderRuntime()).toBe("");
    expect(render()).not.toContain("Runtime ·");
  });
  it("retains progress on the old ready generation while its replacement drains", () => {
    state.cloudEntitled = true;
    Object.assign(state.workspace!, { status: "ready", recovery: null });
    state.availability!.transition = { id: "33333333-3333-4333-8333-333333333333", generation: 2,
      runtimeId: state.availability!.latestRuntimeId!, state: "draining", error: null };
    state.availability!.unavailableReason = "cloud_generation_transition_active";
    expect(renderRuntime()).toContain("Starting the cloud workspace…");
    expect(render()).not.toContain("Update available");
  });
  it("keeps next-wake information visible while a cloud turn runs", () => {
    state.cloudEntitled = true;
    state.running = true;
    Object.assign(state.workspace!, { status: "ready", recovery: null });
    expect(render()).not.toContain("Update runtime");
    expect(renderRuntime()).toContain("Updates automatically the next time this workspace wakes");
  });
  it("does not read or offer runtime updates for retired generations", () => {
    state.cloudEntitled = true;
    state.workspace!.capabilities.startUnavailableReason = "cloud_workspace_v2_required";
    expect(renderRuntime()).toBe("");
    expect(state.runtimeReads).toEqual([false]);
    const html = render();
    expect(html).toContain("This workspace uses a retired cloud runtime — create a new workspace.");
    expect(html).not.toContain("Recover workspace");
    expect(html).not.toContain("Start workspace");
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
