import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkspaceService } from "../../workspace/service";
import {
  getWorkspaceDesignApi,
  resetWorkspaceDesignApisForTests,
} from "../design-api";
import { withDesignDirectoryNameLease } from "../directory-registry";
import { serializeDesignRegistration } from "../manifest";
import { migrateDesignDirectoryPages } from "../pages-migration";
import {
  documentDesignHistoryEntry,
  type WorkspaceDesignHistoryState,
} from "../workspace-history";
import {
  getDesignRuntimeAudit,
  resetDesignRuntimeAuditsForTests,
  setDesignRuntimeAudit,
} from "../runtime-audits";
import {
  getDesignScreenshot,
  resetDesignScreenshotsForTests,
  setDesignScreenshot,
} from "../screenshots";

let root: string;
const directory = "Screens";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "zeros-design-pages-cache-"));
  process.env.ZEROS_DATA_DIR = path.join(root, "private");
  mkdirSync(path.join(root, directory));
  writeFileSync(
    path.join(root, directory, "design.toml"),
    serializeDesignRegistration("design_cache"),
  );
  writeFileSync(
    path.join(root, directory, "canvas.json"),
    JSON.stringify({
      version: 1,
      frames: {
        home: {
          kind: "html",
          source: "home.html",
          title: "Home",
          x: 0,
          y: 0,
          width: 800,
          height: 600,
        },
      },
    }),
  );
  writeFileSync(
    path.join(root, directory, "home.html"),
    '<!doctype html><main data-oid="home">Home</main>',
  );
});
afterEach(() => {
  resetWorkspaceDesignApisForTests();
  resetDesignRuntimeAuditsForTests();
  resetDesignScreenshotsForTests();
  delete process.env.ZEROS_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

it("invalidates retained filename-based audits for only the migrated directory", async () => {
  const sourceVersion = "a".repeat(24);
  const publish = (frame: string) =>
    setDesignRuntimeAudit({
      workspacePath: root,
      frame,
      sourceVersion,
      warnings: [
        {
          severity: "warning",
          ruleId: "contrast",
          file: frame,
          message: "Check contrast",
          line: 1,
          column: 1,
        },
      ],
    });
  await withDesignDirectoryNameLease(root, "Other", async () =>
    publish("other.html"),
  );
  await withDesignDirectoryNameLease(root, directory, async () => {
    publish("home.html");
    expect(
      getDesignRuntimeAudit(root, "home.html", sourceVersion),
    ).toHaveLength(1);
    migrateDesignDirectoryPages(root, directory);
    expect(getDesignRuntimeAudit(root, "home.html", sourceVersion)).toEqual([]);
  });
  await withDesignDirectoryNameLease(root, "Other", async () => {
    expect(
      getDesignRuntimeAudit(root, "other.html", sourceVersion),
    ).toHaveLength(1);
  });
});

it("invalidates whole-frame and node pixels using the directory migration generation", async () => {
  const sourceVersion = "a".repeat(24);
  const publish = (frame: string, nodeId: string | null) =>
    setDesignScreenshot(
      {
        workspaceId: "workspace",
        frame,
        nodeId,
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        width: 1,
        height: 1,
        scale: 1,
        capturedAt: 1,
        sourceVersion,
      },
      root,
    );
  await withDesignDirectoryNameLease(root, "Other", async () =>
    publish("other.html", null),
  );
  await withDesignDirectoryNameLease(root, directory, async () => {
    publish("home.html", null);
    publish("home.html", "hero");
    expect(
      getDesignScreenshot("workspace", "home.html", null, sourceVersion),
    ).not.toBeNull();
    migrateDesignDirectoryPages(root, directory);
    expect(
      getDesignScreenshot("workspace", "home.html", null, sourceVersion),
    ).toBeNull();
    expect(
      getDesignScreenshot("workspace", "home.html", "hero", sourceVersion),
    ).toBeNull();
  });
  expect(
    getDesignScreenshot("workspace", "other.html", null, sourceVersion),
  ).not.toBeNull();
});

it("invalidates retained semantic sessions after migration and leaves old frame references stale", async () => {
  await withDesignDirectoryNameLease(root, directory, async () => {
    const api = getWorkspaceDesignApi(root);
    await api.open("frame:home.html");
    expect(getWorkspaceDesignApi(root)).toBe(api);
    migrateDesignDirectoryPages(root, directory);
    const next = getWorkspaceDesignApi(root);
    expect(next).not.toBe(api);
    await expect(next.open("frame:home.html")).rejects.toThrow(
      /not found|missing|stale/i,
    );
    await expect(next.open("frame:page-1/home.html")).resolves.toMatchObject({
      documentId: "frame:page-1/home.html",
    });
    expect(getWorkspaceDesignApi(root)).toBe(next);
  });
});

it("clears all actors' visual history for the migrated directory while preserving unrelated workspace history", async () => {
  const service = new WorkspaceService(root) as unknown as {
    designHistoryState(
      workspace: string,
      create?: boolean,
      actorId?: string,
    ): WorkspaceDesignHistoryState | undefined;
  };
  const other = path.join(root, "other-workspace");
  mkdirSync(other);
  const unaffected = service.designHistoryState(other, true)!;
  unaffected.undo.push(documentDesignHistoryEntry("other.html"));
  await withDesignDirectoryNameLease(root, directory, async () => {
    for (const actor of [undefined, "human-one", "human-two"]) {
      const state = service.designHistoryState(root, true, actor)!;
      state.undo.push(documentDesignHistoryEntry("home.html"));
      state.redo.push(documentDesignHistoryEntry("home.html"));
      state.bytes = 256;
    }
    migrateDesignDirectoryPages(root, directory);
    for (const actor of [undefined, "human-one", "human-two"])
      expect(service.designHistoryState(root, false, actor)).toEqual({
        undo: [],
        redo: [],
        bytes: 0,
      });
    expect(service.designHistoryState(other)?.undo).toHaveLength(1);
  });
});

it("prunes deleted frame history for every actor in only the current workspace and directory", async () => {
  const service = new WorkspaceService(root) as unknown as {
    designHistoryState(
      workspace: string,
      create?: boolean,
      actorId?: string,
    ): WorkspaceDesignHistoryState;
    pruneDesignHistoryFrames(
      workspace: string,
      frames: readonly string[],
    ): void;
  };
  const unrelated = service.designHistoryState(
    path.join(root, "other-workspace"),
    true,
  );
  unrelated.undo.push(documentDesignHistoryEntry("page-b/home.html"));
  const otherDirectory = await withDesignDirectoryNameLease(
    root,
    "Other",
    async () => {
      const state = service.designHistoryState(
        root,
        true,
        "other-directory-actor",
      );
      state.undo.push(documentDesignHistoryEntry("page-b/home.html"));
      return state;
    },
  );
  await withDesignDirectoryNameLease(root, directory, async () => {
    const states = [undefined, "human-one", "human-two"].map((actor) => {
      const state = service.designHistoryState(root, true, actor);
      const kept = documentDesignHistoryEntry("page-a/home.html");
      const removed = documentDesignHistoryEntry("page-b/home.html");
      state.undo = [kept, removed];
      state.redo = [removed];
      state.bytes = kept.bytes + 2 * removed.bytes;
      return { state, kept };
    });
    service.pruneDesignHistoryFrames(root, ["page-b/home.html"]);
    for (const { state, kept } of states) {
      expect(state).toEqual({ undo: [kept], redo: [], bytes: kept.bytes });
    }
    expect(unrelated.undo).toHaveLength(1);
    expect(otherDirectory.undo).toHaveLength(1);
  });
});
