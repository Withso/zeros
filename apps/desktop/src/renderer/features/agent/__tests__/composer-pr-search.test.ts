import { afterEach, describe, expect, it, vi } from "vitest";
import { ghPrList, type PR } from "../../../platform/git";
import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { ComposerPrSearch } from "../composer-pr-search";
import { composerPrsCache, clearCloudComposerPrs, invalidateAllEngineReadCaches } from "../../../state/read-caches";

vi.mock("../../../platform/git", () => ({ ghPrList: vi.fn() }));
const list = vi.mocked(ghPrList);
const url = "https://github.com/example/project.git";
const cloud = cloudWorkspaceKey({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" });
const rows = (title: string) => [{ number: 1, title }] as PR[];
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
afterEach(() => { composerPrsCache.clear(); vi.resetAllMocks(); });

describe("composer PR discovery", () => {
  it("routes cloud requests to their workspace and preserves Local repository discovery", async () => {
    list.mockResolvedValue([]);
    const search = new ComposerPrSearch(() => {});
    search.search(cloud, url);
    await tick();
    expect(list).toHaveBeenLastCalledWith({ workspaceId: cloud, originUrl: url, state: "open" });
    search.search("/local", url);
    await tick();
    expect(list).toHaveBeenLastCalledWith({ originUrl: url, state: "open" });
    search.clear();
  });

  it("deduplicates exact-owner requests and never shows a late previous workspace response", async () => {
    const old = deferred<PR[]>(), next = deferred<PR[]>();
    list.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const changed = vi.fn(), first = new ComposerPrSearch(changed), second = new ComposerPrSearch(() => {});
    first.search("/local", url);
    second.search("/local", url);
    await tick();
    expect(list).toHaveBeenCalledTimes(1);
    first.search(cloud, url);
    await tick();
    changed.mockClear();
    old.resolve(rows("local"));
    await tick();
    expect(changed).not.toHaveBeenCalled();
    expect(first.snapshot(cloud, url)?.data).toBeUndefined();
    next.resolve(rows("cloud"));
    await tick();
    expect(first.snapshot(cloud, url)?.data?.[0].title).toBe("cloud");
    first.search("/local", url);
    expect(first.snapshot("/local", url)?.data?.[0].title).toBe("local");
    await tick();
    expect(list).toHaveBeenCalledTimes(2);
    first.clear(); second.clear();
  });

  it("retains same-owner rows on failed refresh without retry loops and stops work when hidden", async () => {
    list.mockResolvedValueOnce(rows("confirmed"));
    const search = new ComposerPrSearch(() => {});
    search.search(cloud, url);
    await tick();
    const confirmed = search.snapshot(cloud, url)?.data;
    list.mockRejectedValue(new Error("offline"));
    invalidateAllEngineReadCaches();
    expect(search.snapshot(cloud, url)?.data).toBe(confirmed);
    await tick();
    expect(search.snapshot(cloud, url)?.data).toBe(confirmed);
    expect(search.snapshot(cloud, url)?.error?.message).toBe("offline");
    search.search(cloud, url);
    await tick();
    expect(list).toHaveBeenCalledTimes(2);
    search.clear();
    invalidateAllEngineReadCaches();
    await tick();
    expect(list).toHaveBeenCalledTimes(2);
    search.search(cloud, url);
    await tick();
    expect(list).toHaveBeenCalledTimes(3);
    search.clear();
  });

  it("drops private rows on account change and rejects pending responses from the old account", async () => {
    const old = deferred<PR[]>();
    list.mockReturnValueOnce(old.promise).mockResolvedValueOnce(rows("new account"));
    const search = new ComposerPrSearch(() => {});
    search.search(cloud, url);
    await tick();
    clearCloudComposerPrs();
    old.resolve(rows("old account"));
    await tick();
    expect(search.snapshot(cloud, url)?.data).toBeUndefined();
    search.search(cloud, url);
    await tick();
    expect(search.snapshot(cloud, url)?.data?.[0].title).toBe("new account");
    search.clear();
  });

  it("bounds inactive owners and keeps origin changes separate", async () => {
    list.mockResolvedValue([]);
    const search = new ComposerPrSearch(() => {});
    search.search("/local", url);
    await tick();
    expect(search.snapshot("/local", `${url}different`)?.data).toBeUndefined();
    for (let i = 0; i < 40; i++) {
      search.search(`/checkout-${i}`, url);
      await tick();
    }
    search.clear();
    expect(composerPrsCache.keys().length).toBeLessThanOrEqual(32);
  });
});
