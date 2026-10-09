import { Children, isValidElement, type ReactNode, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCredentialRemovalSnapshot } from "../cloud-credential-removal-controller";

const f = vi.hoisted(() => ({ start: vi.fn(async () => {}), decide: vi.fn(async () => {}), request: vi.fn(),
  snapshot: { busy: false } as CloudCredentialRemovalSnapshot, active: true, userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222", activeId: "33333333-3333-4333-8333-333333333333",
  savedId: "44444444-4444-4444-8444-444444444444" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: <T>(value: T | (() => T)) => [typeof value === "function" ? (value as () => T)() : value, vi.fn()],
  useRef: <T>(value: T) => ({ current: value }), useMemo: <T>(factory: () => T) => factory(), useEffect: vi.fn(),
  useCallback: <T>(callback: T) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../team/team-store", () => ({ useTeams: () => ({ me: { user: { id: f.userId } } }),
  getTeamStoreState: () => ({ me: { user: { id: f.userId } } }), getOrganizationStoreGeneration: () => 1 }));
vi.mock("../internal-features", () => ({ useInternalFeatureActive: () => false }));
vi.mock("../cloud-credential-removal-controller", () => ({ createCloudCredentialRemovalController: () => ({
  start: f.start, decide: f.decide, snapshot: () => f.snapshot, subscribe: () => () => {}, attach: vi.fn(), detach: vi.fn(async () => {}),
}) }));
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: f.request }));
vi.mock("../../../state/use-cached-read", () => ({ useCachedRead: () => ({ data: {
  credentials: [{ id: f.activeId, kind: "claude-api-key", displayName: "Current", revision: 7, revoked: false },
    { id: f.savedId, kind: "claude-api-key", displayName: "Saved", revision: 9, revoked: false }],
  connections: [{ provider: "claude", revision: 12, credentialId: f.activeId, models: ["test"], connected: true }],
}, refresh: vi.fn(async () => {}), error: null }) }));
vi.mock("../../agent/model-catalog", () => ({ modelsForAgent: () => [{ value: "test", label: "Test" }] }));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: vi.fn() }));
import { CloudProviderConnections } from "../cloud-provider-connections";

type Element = ReactElement<{ children?: ReactNode; onClick?: () => Promise<void> | void; disabled?: boolean; active?: boolean }>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, child => { if (isValidElement(child)) { const element = child as Element;
    found.push(element); found.push(...elements(element.props.children)); } });
  return found;
}
function tree() {
  const outer = CloudProviderConnections({ organizationId: f.organizationId, surfaceActive: f.active, Tabs: () => null });
  const component = elements(outer).find(child => typeof child.type === "function" && child.type.name === "CloudProviderConnection")!;
  return (component.type as (props: unknown) => ReactNode)(component.props);
}
function action(name: string) { return elements(tree()).find(element => element.props.children === name)!; }
beforeEach(() => { f.start.mockClear(); f.request.mockClear(); f.decide.mockClear(); f.snapshot = { busy: false }; f.active = true; });
describe("organization Remove and Disconnect integration", () => {
  it("prepares organization Remove with its exact confirmed credential revision", async () => {
    await action("Remove").props.onClick!();
    expect(f.start).toHaveBeenCalledExactlyOnceWith({ kind: "remove-organization-credential", organizationId: f.organizationId,
      credentialId: f.savedId, expectedCredentialRevision: 9 });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("prepares Disconnect with its exact confirmed connection revision", async () => {
    await action("Disconnect").props.onClick!();
    expect(f.start).toHaveBeenCalledExactlyOnceWith({ kind: "disconnect-provider", organizationId: f.organizationId,
      provider: "claude", expectedConnectionRevision: 12 });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("keeps hidden controls inert before any connection mutation", async () => {
    f.active = false;
    for (const name of ["Remove", "Disconnect"]) { const button = action(name); expect(button.props.disabled).toBe(true); await button.props.onClick!(); }
    expect(f.start).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it("does not start another removal while the first operation has an unknown ACK", async () => {
    f.snapshot = { busy: false, state: { operationId: "55555555-5555-4555-8555-555555555555",
      target: { kind: "disconnect-provider", organizationId: f.organizationId, provider: "claude", expectedConnectionRevision: 12 } } };
    const button = action("Remove"); expect(button.props.disabled).toBe(true); await button.props.onClick!();
    expect(f.start).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
});
