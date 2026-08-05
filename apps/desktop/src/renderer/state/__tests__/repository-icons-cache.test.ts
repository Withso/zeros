import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readWorkspaceFile:
    vi.fn<
      (
        repoRoot: string,
        path: string,
      ) => Promise<{ kind?: string; dataUrl?: string } | null>
    >(),
  ghRepositoryOwnerAvatar: vi.fn<() => Promise<null>>(),
  bridge: { connected: true },
}));

vi.mock("../../platform/files", () => ({
  readWorkspaceFile: (repoRoot: string, path: string) =>
    mocks.readWorkspaceFile(repoRoot, path),
}));
vi.mock("../../platform/git", () => ({
  ghRepositoryOwnerAvatar: () => mocks.ghRepositoryOwnerAvatar(),
}));
vi.mock("../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () =>
    mocks.bridge.connected ? { status: "connected" } : null,
  onActiveBridgeConnected: () => () => {},
}));

import {
  automaticRepositoryIconStateCountForTests,
  automaticRepositoryIconStateLimit,
  ensureAutomaticRepositoryIcon,
  getAutomaticRepositoryIcon,
  refreshAutomaticRepositoryIcon,
  resetAutomaticRepositoryIconsForTest,
} from "../../features/repositories/repository-icons";

class MemStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }
  get length(): number {
    return this.values.size;
  }
}

const FAVICON = { kind: "image", dataUrl: "data:image/png;base64,FAVICON" };
const MISS = { kind: "error" } as const;

function readerReturningImageAt(target: string) {
  return async (_root: string, path: string) =>
    path === target ? FAVICON : MISS;
}

async function settled(): Promise<void> {
  await vi.waitFor(() => {
    expect(getAutomaticRepositoryIcon("/repo", "origin")).not.toBeNull();
  });
  // Let the ensure pipeline's .finally retry check run too.
  await Promise.resolve();
  await Promise.resolve();
}

describe("automatic repository icon cache", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage =
      new MemStorage() as unknown as Storage;
    resetAutomaticRepositoryIconsForTest();
    mocks.bridge.connected = true;
    mocks.readWorkspaceFile.mockReset();
    mocks.ghRepositoryOwnerAvatar.mockReset();
    mocks.ghRepositoryOwnerAvatar.mockResolvedValue(null);
  });

  it("detects once, then serves every later ensure from cache", async () => {
    mocks.readWorkspaceFile.mockImplementation(
      readerReturningImageAt("public/favicon.png"),
    );

    ensureAutomaticRepositoryIcon("/repo", "origin");
    await settled();
    const probesAfterFirst = mocks.readWorkspaceFile.mock.calls.length;
    expect(getAutomaticRepositoryIcon("/repo", "origin")).toEqual({
      imageUrl: FAVICON.dataUrl,
      source: { kind: "repository-file", path: "public/favicon.png" },
    });

    // Re-mounting surfaces (dropdown opens, sidebar rows, settings headers)
    // must not re-run detection.
    ensureAutomaticRepositoryIcon("/repo", "origin");
    ensureAutomaticRepositoryIcon("/repo", "origin");
    ensureAutomaticRepositoryIcon("/repo", "origin");
    await Promise.resolve();
    expect(mocks.readWorkspaceFile.mock.calls.length).toBe(probesAfterFirst);
  });

  it("serves a persisted icon synchronously across app sessions, then revalidates once", async () => {
    mocks.readWorkspaceFile.mockImplementation(
      readerReturningImageAt("public/favicon.png"),
    );
    ensureAutomaticRepositoryIcon("/repo", "origin");
    await settled();

    // Simulate an app restart: in-memory state gone, localStorage intact.
    resetAutomaticRepositoryIconsForTest();
    mocks.readWorkspaceFile.mockClear();

    expect(getAutomaticRepositoryIcon("/repo", "origin")).toEqual({
      imageUrl: FAVICON.dataUrl,
      source: { kind: "repository-file", path: "public/favicon.png" },
    });

    // First ensure of the session revalidates in the background…
    ensureAutomaticRepositoryIcon("/repo", "origin");
    await vi.waitFor(() => {
      expect(mocks.readWorkspaceFile.mock.calls.length).toBeGreaterThan(0);
    });
    await settled();
    const probes = mocks.readWorkspaceFile.mock.calls.length;

    // …and later ensures are free again.
    ensureAutomaticRepositoryIcon("/repo", "origin");
    await Promise.resolve();
    expect(mocks.readWorkspaceFile.mock.calls.length).toBe(probes);
  });

  it("treats a bridge-less result as provisional and reruns once the bridge connects", async () => {
    mocks.bridge.connected = false;
    mocks.readWorkspaceFile.mockResolvedValue(MISS);

    ensureAutomaticRepositoryIcon("/repo", "origin");
    await vi.waitFor(() => {
      expect(getAutomaticRepositoryIcon("/repo", "origin")).toEqual({
        imageUrl: null,
        source: null,
      });
    });

    mocks.bridge.connected = true;
    mocks.readWorkspaceFile.mockImplementation(
      readerReturningImageAt("public/favicon.png"),
    );
    ensureAutomaticRepositoryIcon("/repo", "origin");
    await vi.waitFor(() => {
      expect(getAutomaticRepositoryIcon("/repo", "origin")?.imageUrl).toBe(
        FAVICON.dataUrl,
      );
    });
  });

  it("never lets a bridge-less scan overwrite a previously bridged icon", async () => {
    mocks.readWorkspaceFile.mockImplementation(
      readerReturningImageAt("public/favicon.png"),
    );
    ensureAutomaticRepositoryIcon("/repo", "origin");
    await settled();

    mocks.bridge.connected = false;
    mocks.readWorkspaceFile.mockResolvedValue(MISS);
    refreshAutomaticRepositoryIcon("/repo", "origin");
    await vi.waitFor(() => {
      expect(mocks.readWorkspaceFile.mock.calls.length).toBeGreaterThan(0);
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(getAutomaticRepositoryIcon("/repo", "origin")?.imageUrl).toBe(
      FAVICON.dataUrl,
    );
  });

  it("forced refresh picks up a changed icon and persists it", async () => {
    mocks.readWorkspaceFile.mockImplementation(
      readerReturningImageAt("public/favicon.png"),
    );
    ensureAutomaticRepositoryIcon("/repo", "origin");
    await settled();

    const NEXT = { kind: "image", dataUrl: "data:image/png;base64,NEXT" };
    mocks.readWorkspaceFile.mockImplementation(async (_root, path) =>
      path === "public/apple-touch-icon.png" ? NEXT : MISS,
    );
    refreshAutomaticRepositoryIcon("/repo", "origin");
    await vi.waitFor(() => {
      expect(getAutomaticRepositoryIcon("/repo", "origin")?.imageUrl).toBe(
        NEXT.dataUrl,
      );
    });

    // The replacement survives a restart.
    resetAutomaticRepositoryIconsForTest();
    expect(getAutomaticRepositoryIcon("/repo", "origin")?.imageUrl).toBe(
      NEXT.dataUrl,
    );
  });

  it("caches distinct origins separately for the same local path", async () => {
    mocks.readWorkspaceFile.mockResolvedValue(MISS);
    mocks.ghRepositoryOwnerAvatar.mockResolvedValue(null);
    ensureAutomaticRepositoryIcon("/repo", "origin-a");
    await vi.waitFor(() => {
      expect(getAutomaticRepositoryIcon("/repo", "origin-a")).toEqual({
        imageUrl: null,
        source: null,
      });
    });
    expect(getAutomaticRepositoryIcon("/repo", "origin-b")).toBeNull();
  });

  it("bounds inactive runtime snapshots", () => {
    for (
      let index = 0;
      index < automaticRepositoryIconStateLimit + 20;
      index += 1
    ) {
      getAutomaticRepositoryIcon(`/repo-${index}`, `origin-${index}`);
    }

    expect(automaticRepositoryIconStateCountForTests()).toBeLessThanOrEqual(
      automaticRepositoryIconStateLimit,
    );
  });
});
