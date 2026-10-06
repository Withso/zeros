import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";

const fixture = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, refs: [] as Array<{ current: unknown }>,
  cursor: 0, generation: 1, status: vi.fn(), refresh: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => fixture.refs[fixture.cursor++] ??= { current: initial },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => fixture.effects.push(effect),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../workbench/tabs/changes-tab", () => ({ statusForGeneration: fixture.status }));
vi.mock("../../use-git-refresh-key", () => ({ useGitRefreshKey: (...args: unknown[]) => { fixture.refresh(...args); return fixture.generation; } }));
let notice: typeof import("../cloud-history-notice").CloudHistoryNotice;
let forget: typeof import("../pr-cache-forget").forgetPrCachesForWorkspace;
const cleanups: Array<() => void> = [];
const workspace = (id: string) => ({ id, path: `/repo/${id}`, placement: "cloud" }) as Workspace;
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function mount(id = "a", active = true) {
  fixture.cursor = 0; fixture.effects.length = 0;
  const result = notice({ workspace: workspace(id), active });
  for (const effect of fixture.effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  return result;
}
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); fixture.refs = []; fixture.generation = 1;
  ({ CloudHistoryNotice: notice } = await import("../cloud-history-notice"));
  ({ forgetPrCachesForWorkspace: forget } = await import("../pr-cache-forget"));
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe("cloud shallow-history notice", () => {
  it("retains only the matching workspace snapshot through A-B-A and refresh failure", async () => {
    fixture.status.mockResolvedValueOnce({ shallow: true });
    expect(mount()).toBeNull(); await flush();
    expect(mount()?.props.children).toContain("Shallow Git history");
    expect(mount("b", false)).toBeNull();
    expect(mount("a", false)?.props.children).toContain("Shallow Git history");
    expect(fixture.status).toHaveBeenCalledTimes(1);
    fixture.status.mockRejectedValueOnce(new Error("offline")); fixture.generation++;
    mount(); await flush(); mount(); await flush();
    expect(mount("a", false)?.props.children).toContain("Shallow Git history");
    expect(fixture.refresh).toHaveBeenLastCalledWith("/repo/a", "a", false);
    forget("a"); expect(mount("a", false)).toBeNull();
  });

  it("rejects a stale generation and clears the notice after a confirmed full-history fetch", async () => {
    fixture.status.mockResolvedValueOnce({ shallow: true }); mount(); await flush();
    let finish!: (result: { shallow: boolean }) => void;
    fixture.status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fixture.generation++; mount(); await flush(); mount(); await flush();
    fixture.status.mockResolvedValue({ shallow: false });
    fixture.generation++; mount(); await flush(); mount();
    finish({ shallow: true }); await flush(); mount(); await flush();
    expect(mount()).toBeNull();
  });

  it("does not issue reads for hidden or local surfaces", async () => {
    expect(mount("a", false)).toBeNull();
    fixture.cursor = 0; fixture.effects.length = 0;
    expect(notice({ workspace: { ...workspace("local"), placement: "local" }, active: true })).toBeNull();
    for (const effect of fixture.effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    await flush(); expect(fixture.status).not.toHaveBeenCalled();
  });
});
