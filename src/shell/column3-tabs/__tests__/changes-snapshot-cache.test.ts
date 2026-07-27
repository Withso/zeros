import { beforeEach, describe, expect, it } from "vitest";

import type { ChangedFile } from "../changes-parse";
import {
  beginChangesSectionsRequest,
  changesSnapshotCacheLimits,
  changesSnapshotKey,
  forgetChangesSnapshots,
  isCurrentChangesSectionsRequest,
  loadPersistedChangesSnapshots,
  persistChangesCount,
  persistChangesSections,
  readChangesSections,
  subscribeChangesSections,
  writeChangesSections,
} from "../changes-snapshot-cache";

function installStorage(): void {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
}

function changedFile(path = "src/app.tsx"): ChangedFile {
  return {
    path,
    status: "modified",
    additions: 3,
    deletions: 1,
    patch: "diff --git a/src/app.tsx b/src/app.tsx\n+new line",
    binary: false,
    staged: false,
    committed: false,
  };
}

beforeEach(installStorage);

describe("Changes snapshot persistence", () => {
  it("round-trips list metadata under its exact workspace and scope key", () => {
    persistChangesSections("workspace-a", { kind: "all" }, [
      { kind: "committed", title: null, files: [changedFile()] },
    ]);
    persistChangesCount("workspace-a", 7);

    const restored = loadPersistedChangesSnapshots();
    const key = changesSnapshotKey("workspace-a", { kind: "all" });
    const sections = restored.sections.get(key);
    expect(sections?.[0].files[0]).toMatchObject({
      path: "src/app.tsx",
      additions: 3,
      deletions: 1,
      patch: "",
    });
    expect(
      restored.sections.get(
        changesSnapshotKey("workspace-a", { kind: "uncommitted" }),
      ),
    ).toBeUndefined();
    expect(restored.counts.get("workspace-a")).toBe(7);
  });

  it("rejects a legacy badge count computed from porcelain bucket unions", () => {
    localStorage.setItem(
      "zeros-changes-snapshots:v1",
      JSON.stringify({
        version: 1,
        sections: [],
        counts: [{ workspaceId: "workspace-old", savedAt: 1, count: 12 }],
      }),
    );

    expect(loadPersistedChangesSnapshots().counts.has("workspace-old")).toBe(
      false,
    );
  });

  it("removes a stale non-empty boot snapshot after a confirmed empty result", () => {
    const scope = { kind: "all" } as const;
    persistChangesSections("workspace-a", scope, [
      { kind: "committed", title: null, files: [changedFile()] },
    ]);
    persistChangesSections("workspace-a", scope, []);

    expect(
      loadPersistedChangesSnapshots().sections.has(
        changesSnapshotKey("workspace-a", scope),
      ),
    ).toBe(false);
  });

  it("never persists a partial oversized list", () => {
    const scope = { kind: "all" } as const;
    persistChangesSections("workspace-a", scope, [
      { kind: "committed", title: null, files: [changedFile("kept.ts")] },
    ]);
    const oversized = Array.from(
      { length: changesSnapshotCacheLimits.filesPerKey + 1 },
      (_, index) => changedFile(`src/file-${index}.ts`),
    );
    persistChangesSections("workspace-a", scope, [
      { kind: "committed", title: null, files: oversized },
    ]);

    expect(
      loadPersistedChangesSnapshots()
        .sections.get(changesSnapshotKey("workspace-a", scope))?.[0]
        .files.map((file) => file.path),
    ).toEqual(["kept.ts"]);
  });

  it("bounds exact section owners and evicts the oldest snapshot", () => {
    for (
      let index = 0;
      index < changesSnapshotCacheLimits.sectionKeys + 2;
      index += 1
    ) {
      persistChangesSections(`workspace-${index}`, { kind: "all" }, [
        {
          kind: "committed",
          title: null,
          files: [changedFile(`file-${index}.ts`)],
        },
      ]);
    }

    const restored = loadPersistedChangesSnapshots().sections;
    expect(restored.size).toBe(changesSnapshotCacheLimits.sectionKeys);
    expect(
      restored.has(changesSnapshotKey("workspace-0", { kind: "all" })),
    ).toBe(false);
  });

  it("prunes every scope and count owned by a deleted workspace", () => {
    for (const scope of [
      { kind: "all" } as const,
      { kind: "uncommitted" } as const,
      { kind: "staged" } as const,
      { kind: "unstaged" } as const,
    ]) {
      persistChangesSections("workspace-a", scope, [
        { kind: "committed", title: null, files: [changedFile()] },
      ]);
    }
    persistChangesCount("workspace-a", 1);
    persistChangesCount("workspace-b", 2);

    forgetChangesSnapshots(["workspace-a"]);

    const restored = loadPersistedChangesSnapshots();
    expect(
      [...restored.sections.keys()].some((key) => key.includes("workspace-a")),
    ).toBe(false);
    expect(restored.counts.has("workspace-a")).toBe(false);
    expect(restored.counts.get("workspace-b")).toBe(2);
  });

  it("publishes only to the exact scope and rejects an older request token", () => {
    const allKey = changesSnapshotKey("workspace-live", { kind: "all" });
    const uncommittedKey = changesSnapshotKey("workspace-live", {
      kind: "uncommitted",
    });
    let allNotifications = 0;
    let uncommittedNotifications = 0;
    const stopAll = subscribeChangesSections(allKey, () => {
      allNotifications += 1;
    });
    const stopUncommitted = subscribeChangesSections(uncommittedKey, () => {
      uncommittedNotifications += 1;
    });

    const older = beginChangesSectionsRequest(allKey);
    const newer = beginChangesSectionsRequest(allKey);
    expect(isCurrentChangesSectionsRequest(allKey, older)).toBe(false);
    expect(isCurrentChangesSectionsRequest(allKey, newer)).toBe(true);

    writeChangesSections("workspace-live", { kind: "all" }, [
      { kind: "committed", title: null, files: [changedFile("live.ts")] },
    ]);
    expect(readChangesSections(allKey)?.[0].files[0].path).toBe("live.ts");
    expect(allNotifications).toBe(1);
    expect(uncommittedNotifications).toBe(0);

    stopAll();
    stopUncommitted();
  });
});
