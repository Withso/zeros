import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";

const state = vi.hoisted(() => ({ workspace: null as CloudWorkspaceDocument | null, userId: "owner" }));
vi.mock("../../state/use-cached-read", () => ({ useCachedRead: () => ({ data: state.workspace }) }));
vi.mock("../../state/cloud-workspace-catalog", () => ({ cloudWorkspaceDetails: {}, manageCloudWorkspace: vi.fn(), manageCloudWorkspaceRecovery: vi.fn(), refreshCloudWorkspace: vi.fn() }));
vi.mock("../../features/team/team-store", () => ({ useTeams: () => ({ me: { user: { id: state.userId } } }), getOrganizationStoreGeneration: () => 0 }));
vi.mock("../../shared/ui", () => ({ Button: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => createElement("button", { disabled }, children) }));
vi.mock("../../shared/ui/primitives", () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { error: vi.fn() } }));
vi.mock("../../shared/ui/primitives/popover", () => {
  const Content = ({ children }: { children: ReactNode }) => children;
  return { Popover: Content, PopoverContent: Content, PopoverTrigger: Content };
});
import { CloudWorkspaceDetails } from "../conversation/cloud-workspace-details";

function render() {
  return renderToStaticMarkup(createElement(CloudWorkspaceDetails, { folder: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" }));
}
beforeEach(() => {
  state.userId = "owner";
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
describe("cloud checkpoint recovery controls", () => {
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
