import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudCredentialRemovalTarget } from "../cloud-credential-removal";
const f = vi.hoisted(() => ({ userId: "11111111-1111-4111-8111-111111111111", epoch: 1, cursor: 0,
  slots: [] as Array<{ value: unknown; dependencies?: readonly unknown[] }>, start: vi.fn(async () => {}), decide: vi.fn(async () => {}), factories: [] as Array<{ isCurrent(): boolean }> }));
vi.mock("react", () => ({
  useRef: (value: unknown) => { const i = f.cursor++; return (f.slots[i] ??= { value: { current: value } }).value; },
  useMemo: (factory: () => unknown, dependencies: readonly unknown[]) => {
    const i = f.cursor++, prior = f.slots[i];
    if (!prior?.dependencies || dependencies.some((value, n) => !Object.is(value, prior.dependencies![n]))) f.slots[i] = { value: factory(), dependencies };
    return f.slots[i].value;
  },
  useCallback: (value: unknown, dependencies: readonly unknown[]) => {
    const i = f.cursor++, prior = f.slots[i];
    if (!prior?.dependencies || dependencies.some((item, n) => !Object.is(item, prior.dependencies![n]))) f.slots[i] = { value, dependencies };
    return f.slots[i].value;
  },
  // Deliberately hold passive effect cleanup: hidden/foreign handlers must be
  // fenced by the new render before its effects run.
  useEffect: () => {}, useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../../team/team-store", () => ({ getOrganizationStoreGeneration: () => f.epoch,
  getTeamStoreState: () => ({ me: { user: { id: f.userId } } }) }));
vi.mock("../../../shared/ui/primitives/elements", () => ({ toast: { error: vi.fn() } }));
vi.mock("../cloud-credential-removal-controller", () => ({ createCloudCredentialRemovalController: (options: { isCurrent(): boolean }) => {
  f.factories.push(options); return { start: f.start, decide: f.decide, snapshot: () => ({ busy: false }),
    subscribe: () => () => {}, attach: vi.fn(), detach: vi.fn(async () => {}) };
} }));
import { useCloudCredentialRemoval } from "../use-cloud-credential-removal";
const organizationId = "22222222-2222-4222-8222-222222222222", otherOrganizationId = "33333333-3333-4333-8333-333333333333";
const target: CloudCredentialRemovalTarget = { kind: "disconnect-provider", organizationId, provider: "cursor", expectedConnectionRevision: 1 };
function RenderRemoval(active = true, org = organizationId) { f.cursor = 0; return useCloudCredentialRemoval({ userId: f.userId, organizationId: org, active, onRemoved: vi.fn() }); }
beforeEach(() => { f.epoch = 1; f.cursor = 0; f.slots = []; f.factories = []; f.start.mockClear(); f.decide.mockClear(); });
describe("Settings removal hook ownership", () => {
  it("fences old buttons synchronously when the retained surface becomes inactive", async () => {
    const old = RenderRemoval(); RenderRemoval(false);
    await old.start(target); await old.decide("confirm");
    expect(f.start).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled();
  });
  it("invalidates old organization callbacks before effect cleanup and never revives them on A-B-A", async () => {
    const old = RenderRemoval(); RenderRemoval(true, otherOrganizationId);
    expect(old.current()).toBe(false); expect(f.factories[0].isCurrent()).toBe(false);
    RenderRemoval(); await old.start(target); await old.decide("confirm");
    expect(old.current()).toBe(false); expect(f.start).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled();
  });
  it("fences an old account epoch even after the same account signs in again", async () => {
    const old = RenderRemoval(); f.epoch++; RenderRemoval();
    await old.start(target); await old.decide("confirm");
    expect(f.start).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled();
  });
  it("keeps the exact current surface actionable without waiting for a passive effect", async () => {
    const current = RenderRemoval(); await current.start(target); await current.decide("confirm");
    expect(f.start).toHaveBeenCalledExactlyOnceWith(target); expect(f.decide).toHaveBeenCalledExactlyOnceWith("confirm");
  });
});
