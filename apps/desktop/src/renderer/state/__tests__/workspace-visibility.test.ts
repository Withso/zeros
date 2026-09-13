import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_HIDE_ARCHIVE_MS,
  forgetRepositoryVisibility,
  forgetWorkspaceVisibility,
  hideExpiredWorkspaces,
  readWorkspaceVisibility,
  resetWorkspaceVisibilityForTests,
  setWorkspaceHidden,
  subscribeWorkspaceVisibility,
  workspaceIsHidden,
} from "../../features/dashboard/workspace-visibility";

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  resetWorkspaceVisibilityForTests();
});
const workspace = { id: "a", repoSlug: "repo", archivedAt: 1000 };
const hidden = (owner = workspace, autoHide = false, now = 1000) =>
  workspaceIsHidden(owner, readWorkspaceVisibility(), autoHide, now);

describe("dashboard workspace hiding", () => {
  it("hides only the selected archive and survives a reload", () => {
    setWorkspaceHidden(workspace, true);
    expect(hidden()).toBe(true);
    expect(hidden({ ...workspace, id: "b" })).toBe(false);
    resetWorkspaceVisibilityForTests();
    expect(hidden()).toBe(true);
    setWorkspaceHidden(workspace, false);
    expect(hidden()).toBe(false);
  });
  it("requires 15 continuous days, resetting after unarchive and rearchive", () => {
    expect(hidden(workspace, true, 1000 + AUTO_HIDE_ARCHIVE_MS - 1)).toBe(
      false,
    );
    expect(hidden(workspace, true, 1000 + AUTO_HIDE_ARCHIVE_MS)).toBe(true);
    hideExpiredWorkspaces([workspace], 1000 + AUTO_HIDE_ARCHIVE_MS);
    expect(
      workspaceIsHidden(
        { ...workspace, archivedAt: null },
        readWorkspaceVisibility(),
        true,
        Infinity,
      ),
    ).toBe(false);
    const rearchived = {
      ...workspace,
      archivedAt: 1000 + AUTO_HIDE_ARCHIVE_MS,
    };
    expect(
      hidden(
        rearchived,
        true,
        rearchived.archivedAt + AUTO_HIDE_ARCHIVE_MS - 1,
      ),
    ).toBe(false);
    expect(
      hidden(rearchived, true, rearchived.archivedAt + AUTO_HIDE_ARCHIVE_MS),
    ).toBe(true);
  });
  it("keeps applied automatic hides when disabled and honors explicit Unhide", () => {
    hideExpiredWorkspaces([workspace], 1000 + AUTO_HIDE_ARCHIVE_MS);
    expect(hidden()).toBe(true);
    setWorkspaceHidden(workspace, false);
    hideExpiredWorkspaces([workspace], 1000 + 2 * AUTO_HIDE_ARCHIVE_MS);
    expect(hidden(workspace, true, 1000 + 2 * AUTO_HIDE_ARCHIVE_MS)).toBe(
      false,
    );
  });
  it("does not let a previous archive period hide the current one", () => {
    const rearchived = { ...workspace, archivedAt: 2000 };
    setWorkspaceHidden(workspace, true);
    expect(hidden(rearchived)).toBe(false);
  });
  it("ignores delayed hiding and restore cleanup from a previous archive period", () => {
    const rearchived = { ...workspace, archivedAt: 2000 };
    setWorkspaceHidden(rearchived, true);
    setWorkspaceHidden(workspace, false);
    expect(hidden(rearchived)).toBe(true);
    forgetWorkspaceVisibility(workspace.id, workspace.archivedAt);
    expect(hidden(rearchived)).toBe(true);
    forgetWorkspaceVisibility(rearchived.id, rearchived.archivedAt);
    expect(hidden(rearchived)).toBe(false);
  });
  it("retains automatic hides beyond the manual-entry limit without republishing", () => {
    const archives = Array.from({ length: 5001 }, (_, index) => ({
      ...workspace,
      id: `workspace-${index}`,
    }));
    const listener = vi.fn();
    subscribeWorkspaceVisibility(listener);
    hideExpiredWorkspaces(archives, 1000 + AUTO_HIDE_ARCHIVE_MS);
    const snapshot = readWorkspaceVisibility();
    hideExpiredWorkspaces(archives, 1000 + AUTO_HIDE_ARCHIVE_MS);
    expect(readWorkspaceVisibility()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    resetWorkspaceVisibilityForTests();
    expect(archives.every((owner) => hidden(owner))).toBe(true);
  });
  it("publishes a batch once and retains references for unchanged snapshots", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWorkspaceVisibility(listener);
    hideExpiredWorkspaces(
      [workspace, { ...workspace, id: "b" }],
      1000 + AUTO_HIDE_ARCHIVE_MS,
    );
    const snapshot = readWorkspaceVisibility();
    hideExpiredWorkspaces([workspace], 1000 + AUTO_HIDE_ARCHIVE_MS);
    expect(readWorkspaceVisibility()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
  it("cleans only the deleted workspace or repository", () => {
    setWorkspaceHidden(workspace, true);
    const other = { ...workspace, id: "b", repoSlug: "other" };
    setWorkspaceHidden(other, true);
    forgetRepositoryVisibility(workspace.repoSlug);
    expect(hidden()).toBe(false);
    expect(hidden(other)).toBe(true);
    forgetWorkspaceVisibility(other.id);
    expect(hidden(other)).toBe(false);
  });
  it("rejects malformed persisted entries", () => {
    storage.set(
      "zeros:dashboard-workspace-visibility:v1",
      JSON.stringify({
        entries: {
          a: { archivedAt: "1000", hidden: true, repoSlug: "repo" },
          b: null,
        },
        autoHiddenBefore: -1,
      }),
    );
    expect(readWorkspaceVisibility()).toEqual({
      entries: {},
      autoHiddenBefore: null,
    });
  });
});
