import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>,
  listeners: new Set<() => void>(), generation: 1, warm: vi.fn<() => Promise<void>>(), toast: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => mocks.effects.push(effect),
  useCallback: (callback: unknown) => callback,
  useDebugValue: () => {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../cloud-workspace-catalog", async original => ({ ...await original<typeof import("../cloud-workspace-catalog")>(),
  cloudWorkspaceDocument: () => ({ status: "ready", deletedAt: null, generation: { number: mocks.generation } }),
  subscribeCloudWorkspaces: (fn: () => void) => { mocks.listeners.add(fn); return () => { mocks.listeners.delete(fn); }; },
}));
vi.mock("../cloud-workspace-warmup", () => ({ warmCloudWorkspaceDestination: mocks.warm }));
vi.mock("../store", async original => ({ ...await original<typeof import("../store")>(),
  useWorkspaceStore: () => "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { error: mocks.toast } }));
import { CloudWorkspaceLifecycle } from "../cloud-workspace-lifecycle";
import { useWorkspaceStore } from "../workspace-store";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../../platform/bridge/active-bridge";
const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
let client: WorkspaceRuntimeClient;
let cleanup: void | (() => void);
beforeEach(() => {
  mocks.effects.length = 0; mocks.listeners.clear(); mocks.generation = 1; mocks.warm.mockReset(); mocks.toast.mockClear();
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  client = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => [] }); setActiveBridge(client);
  useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder, repoRoot: folder, chatId: null });
});
afterEach(() => { cleanup?.(); setActiveBridge(null); client.dispose(); vi.unstubAllGlobals(); });
it("starts the newly selected generation without waiting for a retired connection or a later poll", async () => {
  let rejectOld!: (error: Error) => void;
  const old = new Promise<void>((_r, reject) => { rejectOld = reject; });
  mocks.warm.mockReturnValueOnce(old).mockResolvedValue(undefined);
  CloudWorkspaceLifecycle(); cleanup = mocks.effects.at(-1)!();
  expect(mocks.warm).toHaveBeenCalledTimes(1);
  mocks.generation++;
  for (const listener of mocks.listeners) listener();
  expect(mocks.warm).toHaveBeenCalledTimes(2);
  rejectOld(new Error("retired generation"));
  await Promise.resolve(); await Promise.resolve();
  expect(mocks.toast).not.toHaveBeenCalled();
});
