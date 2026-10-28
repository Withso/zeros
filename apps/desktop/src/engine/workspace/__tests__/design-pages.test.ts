import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeState, setStateRootForTesting } from "../../git";
import { insertWorkspace } from "../../git/state";
import { WorkspaceService } from "../service";
import { withDesignDirectoryNameLease } from "../../design/directory-registry";
import { withDesignWorkspaceMutation } from "../../design/document-write-lock";
import { getDesignPageHint } from "../../design/page-selection";
import { getWorkspaceDesignApi, resetWorkspaceDesignApisForTests } from "../../design/design-api";
import { readDesignFrame } from "../../design/document";
import { MAX_DESIGN_HISTORY_BYTES } from "../../design/workspace-history";

type Snapshot = {
  directoryId: string;
  directory: string;
  pages: Array<{
    id: string;
    title: string;
    folder: string;
    frameFiles: string[];
  }>;
  frames: Array<{ file: string; pageId: string; frameId: string }>;
};

describe("page operations through WorkspaceService", () => {
  let root: string;
  let service: WorkspaceService;
  let initial: Snapshot;
  const params = { workspaceId: "local-main" };
  const options = { hostLocalResources: false };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-workspace-design-pages-"));
    setStateRootForTesting(path.join(root, "state"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    await writeFile(path.join(root, "code.txt"), "Code\n");
    git("add", "code.txt");
    git("commit", "-qm", "Fixture");
    service = new WorkspaceService(root);
    insertWorkspace(service["localMainEntry"]());
    initial = (
      (await service.handle("design.initialize", params, options)) as {
        snapshot: Snapshot;
      }
    ).snapshot;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resetWorkspaceDesignApisForTests();
    closeState();
    await rm(root, { recursive: true, force: true });
  });

  it("returns a catalog/snapshot for page lifecycle and restores it through history without touching HEAD or the index", async () => {
    const head = git("rev-parse", "HEAD");
    const index = readFileSync(path.join(root, ".git/index"));
    const created = (await service.handle(
      "design.page.create",
      { ...params, directoryId: initial.directoryId, title: "Checkout" },
      options,
    )) as { page: Snapshot["pages"][number]; snapshot: Snapshot };
    expect(created.page).toMatchObject({
      title: "Checkout",
      folder: "checkout",
      frameFiles: [],
    });
    expect(created.snapshot.pages).toHaveLength(2);
    const renamed = (await service.handle(
      "design.page.rename",
      { ...params, pageId: created.page.id, title: "Purchase" },
      options,
    )) as { page: Snapshot["pages"][number]; snapshot: Snapshot };
    expect(renamed.page).toMatchObject({
      id: created.page.id,
      title: "Purchase",
      folder: "checkout",
    });
    await service.handle("design.themes.update", { ...params, theme: { id: "light", label: "Day" } }, options);
    const named = (await service.handle(
      "design.themes.update",
      { ...params, theme: { id: "dark", label: "Dark", base: true } },
      options,
    )) as { themes: unknown; snapshot: Snapshot & { themes: unknown } };
    expect(named.themes).toEqual([{ id: "dark", label: "Dark", base: true }, { id: "light", label: "Day" }]);
    expect(named.snapshot.themes).toEqual([{ id: "dark", label: "Dark", base: true }, { id: "light", label: "Day" }]);
    await expect(service.handle("design.themes.update", { ...params, theme: { id: "Dark", label: "Dark" } }, options))
      .rejects.toThrow(/lowercase letter/);
    const deleted = (await service.handle(
      "design.page.delete",
      { ...params, pageId: created.page.id, expectedFrameIds: [] },
      options,
    )) as { deleted: { pageId: string }; snapshot: Snapshot };
    expect(deleted).toMatchObject({
      deleted: { pageId: created.page.id },
      snapshot: { pages: initial.pages },
    });
    expect(
      service.lifecycleMutationWorkspaceId("design.page.create", params),
    ).toBe("local-main");
    expect(
      service.lifecycleMutationWorkspaceId("design.page.select", params),
    ).toBeNull();
    const undo = (await service.handle(
      "design.history.undo",
      params,
      options,
    )) as { result: unknown; snapshot: Snapshot };
    expect(undo.result).toBeNull();
    expect(undo.snapshot.pages).toEqual(renamed.snapshot.pages);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(path.join(root, ".git/index"))).toEqual(index);
  });

  it("orders page creation, rename and theme default edits in the shared Design history", async () => {
    const call = (op: string, extra = {}) => service.handle(op, { ...params, ...extra }, options);
    const created = await call("design.page.create", { title: "Checkout" }) as { page: Snapshot["pages"][number]; snapshot: Snapshot };
    const renamed = await call("design.page.rename", { pageId: created.page.id, title: "Purchase" }) as { snapshot: Snapshot };
    await call("design.themes.update", { theme: { id: "light", label: "Day", base: true } });
    const themed = await call("design.themes.update", { theme: { id: "dark", label: "Night", base: true } }) as { snapshot: Snapshot & { themes: unknown[] } };
    type Reply = { historyPageId?: string; snapshot: Snapshot & { themes: unknown[] } };
    const themeUndo = await call("design.history.undo") as Reply;
    expect(themeUndo.snapshot.themes).toEqual([{ id: "light", label: "Day", base: true }]);
    expect((await call("design.history.undo") as Reply).snapshot.themes).toEqual([]);
    const renameUndo = await call("design.history.undo") as Reply;
    expect(renameUndo.snapshot.pages).toEqual(created.snapshot.pages);
    expect(renameUndo.historyPageId).toBe(created.page.id);
    expect((await call("design.history.undo") as Reply).snapshot.pages).toEqual(initial.pages);
    const createRedo = await call("design.history.redo") as Reply;
    expect(createRedo.snapshot.pages).toEqual(created.snapshot.pages);
    expect(createRedo.historyPageId).toBe(created.page.id);
    expect((await call("design.history.redo") as Reply).snapshot.pages).toEqual(renamed.snapshot.pages);
    await call("design.history.redo");
    expect((await call("design.history.redo") as Reply).snapshot.themes).toEqual(themed.snapshot.themes);
  });

  it("keeps history selection on an empty affected page when another page still has frames", async () => {
    const call = (op: string, extra = {}) => service.handle(op, { ...params, ...extra }, options);
    await call("design.frame.create", { title: "First", pageId: initial.pages[0]!.id });
    const created = await call("design.page.create", { title: "Second" }) as { page: Snapshot["pages"][number] };
    await call("design.page.rename", { pageId: created.page.id, title: "Renamed" });
    const pageUndo = await call("design.history.undo") as { historyPageId?: string; historySelection?: string | null };
    expect(pageUndo.historyPageId).toBe(created.page.id);
    expect(pageUndo.historySelection).toBeNull();
    const frame = await call("design.frame.create", { title: "Second frame", pageId: created.page.id }) as { frame: Snapshot["frames"][number] };
    await call("design.frame.delete", { frame: frame.frame.file });
    await call("design.history.undo");
    const deletedAgain = await call("design.history.redo") as { historyFrame?: string; historySelection?: string | null };
    expect(deletedAgain.historyFrame).toBe(frame.frame.file);
    expect(deletedAgain.historySelection).toBeNull();
  });

  it("restores deleted page sources, stable metadata and earlier document Undo/Redo", async () => {
    const call = (op: string, extra = {}) => service.handle(op, { ...params, ...extra }, options);
    const created = await call("design.page.create", { title: "Checkout" }) as { page: Snapshot["pages"][number] };
    const framed = await call("design.frame.create", { title: "Receipt", pageId: created.page.id }) as { frame: Snapshot["frames"][number] };
    const file = framed.frame.file;
    const readFrame = () => withDesignDirectoryNameLease(root, initial.directory, () => readDesignFrame(root, file));
    const before = await readFrame();
    const nodeId = before.source.match(/data-oid="([^"]+)"/)![1]!;
    await call("design.node.styles", { frame: file, sourceVersion: before.sourceVersion, nodeId, styles: { color: "rebeccapurple" } });
    const edited = await readFrame();
    const canvasFile = path.join(root, initial.directory, "meta/canvas.json");
    const authored = JSON.parse(readFileSync(canvasFile, "utf8"));
    authored.pages.find((page: { id: string }) => page.id === created.page.id).extension = { keep: "page data" };
    await writeFile(canvasFile, JSON.stringify(authored));
    await call("design.page.delete", { pageId: created.page.id, expectedFrameIds: [framed.frame.frameId] });
    expect(existsSync(path.join(root, initial.directory, file))).toBe(false);
    const restored = await call("design.history.undo") as { historyPageId?: string; snapshot: Snapshot };
    expect(restored.historyPageId).toBe(created.page.id);
    expect(restored.snapshot.frames.find(frame => frame.file === file)?.frameId).toBe(framed.frame.frameId);
    expect((await readFrame()).source).toBe(edited.source);
    expect(JSON.parse(readFileSync(canvasFile, "utf8")).pages).toEqual(authored.pages);
    await call("design.history.undo", { frame: file });
    expect((await readFrame()).source).toBe(before.source);
    await call("design.history.redo", { frame: file });
    expect((await readFrame()).source).toBe(edited.source);
    await call("design.history.redo", { frame: file });
    expect(existsSync(path.join(root, initial.directory, file))).toBe(false);
  });

  it("refuses a catalog inverse after an external metadata edit without consuming it", async () => {
    const pageId = initial.pages[0]!.id;
    await service.handle("design.page.rename", { ...params, pageId, title: "Renamed" }, options);
    const file = path.join(root, initial.directory, "meta/canvas.json");
    const saved = readFileSync(file, "utf8");
    const external = JSON.parse(saved); external.extension = { native: true };
    const changed = JSON.stringify(external); await writeFile(file, changed);
    await expect(service.handle("design.history.undo", params, options)).rejects.toThrow(/changed|history/i);
    expect(readFileSync(file, "utf8")).toBe(changed);
    await writeFile(file, saved);
    const retried = await service.handle("design.history.undo", params, options) as { snapshot: Snapshot };
    expect(retried.snapshot.pages).toEqual(initial.pages);
  });

  it("keeps a missing registered source absent through page deletion Undo and Redo", async () => {
    const call = (op: string, extra = {}) => service.handle(op, { ...params, ...extra }, options);
    const created = await call("design.page.create") as { page: Snapshot["pages"][number] };
    const framed = await call("design.frame.create", { title: "Missing", pageId: created.page.id }) as { frame: Snapshot["frames"][number] };
    const source = path.join(root, initial.directory, framed.frame.file);
    await rm(source);
    await call("design.page.delete", { pageId: created.page.id, expectedFrameIds: [framed.frame.frameId] });
    const restored = await call("design.history.undo") as { snapshot: Snapshot };
    expect(restored.snapshot.pages.find(page => page.id === created.page.id)?.frameFiles).toEqual([framed.frame.file]);
    expect(existsSync(source)).toBe(false);
    await call("design.history.redo");
    expect(existsSync(source)).toBe(false);
    expect(existsSync(path.dirname(source))).toBe(false);
  });

  it("stops capturing deleted-page document checkpoints at the existing history byte cap", async () => {
    const call = (op: string, extra = {}) => service.handle(op, { ...params, ...extra }, options);
    const created = await call("design.page.create") as { page: Snapshot["pages"][number] };
    const frames: Snapshot["frames"] = [];
    for (let index = 0; index < 3; index++) {
      const result = await call("design.frame.create", { title: `Frame ${index}`, pageId: created.page.id }) as { frame: Snapshot["frames"][number] };
      frames.push(result.frame);
    }
    await withDesignDirectoryNameLease(root, initial.directory, async () => {
      const api = getWorkspaceDesignApi(root);
      const capture = api.captureLocalHistory.bind(api);
      const spy = vi.spyOn(api, "captureLocalHistory").mockImplementation(async document => ({
        ...await capture(document), bytes: MAX_DESIGN_HISTORY_BYTES / 2 + 1,
      }));
      await call("design.page.delete", { pageId: created.page.id, expectedFrameIds: frames.map(frame => frame.frameId) });
      expect(spy).toHaveBeenCalledTimes(2);
    });
    const undo = await call("design.history.undo") as { snapshot: Snapshot };
    expect(undo.snapshot.pages.map(page => page.id)).not.toContain(created.page.id);
  });

  it("refuses page source collisions in both directions and keeps the inverse retriable", async () => {
    const call = (op: string, extra = {}) => service.handle(op, { ...params, ...extra }, options);
    const created = await call("design.page.create") as { page: Snapshot["pages"][number] };
    const framed = await call("design.frame.create", { title: "Receipt", pageId: created.page.id }) as { frame: Snapshot["frames"][number] };
    const source = path.join(root, initial.directory, framed.frame.file);
    const canvas = path.join(root, initial.directory, "meta/canvas.json");
    const original = readFileSync(source, "utf8");
    await call("design.page.delete", { pageId: created.page.id, expectedFrameIds: [framed.frame.frameId] });
    const deleted = readFileSync(canvas, "utf8");
    await mkdir(path.dirname(source));
    await writeFile(source, "Native source must survive");
    await expect(call("design.history.undo")).rejects.toThrow(/changed|conflict/i);
    expect(readFileSync(source, "utf8")).toBe("Native source must survive");
    expect(readFileSync(canvas, "utf8")).toBe(deleted);
    await rm(source);
    await call("design.history.undo");
    expect(readFileSync(source, "utf8")).toBe(original);
    const restored = readFileSync(canvas, "utf8");
    await writeFile(source, `${original}\n<!-- native change -->`);
    await expect(call("design.history.redo")).rejects.toThrow(/changed|conflict/i);
    expect(readFileSync(canvas, "utf8")).toBe(restored);
    expect(readFileSync(source, "utf8")).toContain("native change");
    await writeFile(source, original);
    await call("design.history.redo");
    expect(existsSync(source)).toBe(false);
  });

  it("refuses a symlinked registered source without deleting its page or target", async () => {
    const call = (op: string, extra = {}) => service.handle(op, { ...params, ...extra }, options);
    const created = await call("design.page.create") as { page: Snapshot["pages"][number] };
    const framed = await call("design.frame.create", { title: "Receipt", pageId: created.page.id }) as { frame: Snapshot["frames"][number] };
    const source = path.join(root, initial.directory, framed.frame.file);
    const canvas = path.join(root, initial.directory, "meta/canvas.json");
    const before = readFileSync(canvas, "utf8");
    const foreign = path.join(root, "foreign.html");
    await writeFile(foreign, "Foreign source");
    await rm(source);
    await symlink(foreign, source);
    await expect(call("design.page.delete", { pageId: created.page.id, expectedFrameIds: [framed.frame.frameId] })).rejects.toThrow();
    expect(readFileSync(canvas, "utf8")).toBe(before);
    expect(readFileSync(foreign, "utf8")).toBe("Foreign source");
  });

  it("requires captured directory ownership and confirmed membership", async () => {
    await expect(
      service.handle(
        "design.page.create",
        { ...params, directoryId: "design_wrong" },
        options,
      ),
    ).rejects.toThrow(/directory.*changed/i);
    const created = (await service.handle(
      "design.page.create",
      params,
      options,
    )) as { page: Snapshot["pages"][number] };
    const frame = (await service.handle(
      "design.frame.create",
      { ...params, title: "Home", pageId: created.page.id },
      options,
    )) as { frame: Snapshot["frames"][number]; snapshot: Snapshot };
    expect(frame.frame).toMatchObject({
      file: "page-2/home.html",
      pageId: created.page.id,
    });
    await expect(
      service.handle(
        "design.page.delete",
        { ...params, pageId: created.page.id, expectedFrameIds: [] },
        options,
      ),
    ).rejects.toThrow(/membership.*changed/i);
    await service.handle(
      "design.page.delete",
      {
        ...params,
        pageId: created.page.id,
        expectedFrameIds: [frame.frame.frameId],
      },
      options,
    );
    expect(
      existsSync(path.join(root, initial.directory, frame.frame.file)),
    ).toBe(false);
  });

  it("does not reuse a snapshot flight started before a page mutation", async () => {
    // The in-flight read belongs to the same exact key but predates this write.
    const host = service as unknown as {
      designSnapshotFlights: Map<string, Promise<Snapshot>>;
    };
    const key = `local-main\u0000${root}\u0000read\u0000${initial.directory}\u0000bridge-resources`;
    host.designSnapshotFlights.set(key, Promise.resolve(initial));
    try {
      const created = (await service.handle(
        "design.page.create",
        { ...params, title: "Checkout" },
        options,
      )) as { page: Snapshot["pages"][number]; snapshot: Snapshot };
      expect(created.snapshot.pages).toHaveLength(2);
      expect(
        created.snapshot.pages.find((page) => page.id === created.page.id),
      ).toEqual(created.page);
    } finally {
      host.designSnapshotFlights.delete(key);
    }
  });

  it("keeps the page mutation lane through its confirmed snapshot while select remains immediate", async () => {
    const created = (await service.handle(
      "design.page.create",
      { ...params, title: "Checkout" },
      options,
    )) as { page: Snapshot["pages"][number] };
    const host = service as unknown as {
      readDesignSnapshot: (...args: unknown[]) => Promise<Snapshot>;
    };
    const readSnapshot = host.readDesignSnapshot.bind(service);
    let release!: () => void;
    let entered!: () => void;
    let overlapped!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const overlap = new Promise<string>((resolve) => {
      overlapped = () => resolve("overlap");
    });
    let calls = 0;
    const spy = vi
      .spyOn(host, "readDesignSnapshot")
      .mockImplementation(async (...args) => {
        if (++calls === 1) {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        } else overlapped();
        return readSnapshot(...args);
      });
    const first = service.handle(
      "design.page.rename",
      { ...params, pageId: created.page.id, title: "First" },
      options,
    );
    let second: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await ready;
      second = service.handle(
        "design.page.rename",
        { ...params, pageId: created.page.id, title: "Second" },
        options,
      );
      const state = await Promise.race([
        overlap,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("serialized"), 500);
        }),
      ]);
      expect(state).toBe("serialized");
      expect(
        await service.handle(
          "design.page.select",
          {
            ...params,
            directoryId: initial.directoryId,
            pageId: created.page.id,
          },
          options,
        ),
      ).toEqual({ ok: true });
      release();
      const replies = (await Promise.all([first, second])) as Array<{
        page: Snapshot["pages"][number];
        snapshot: Snapshot;
      }>;
      expect(replies.map((reply) => reply.page.title)).toEqual([
        "First",
        "Second",
      ]);
      for (const reply of replies)
        expect(
          reply.snapshot.pages.find((page) => page.id === created.page.id),
        ).toEqual(reply.page);
    } finally {
      clearTimeout(timer);
      release?.();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      spy.mockRestore();
    }
  });

  it("keeps select read-class and resolves it while both the directory lease and mutation lane are held", async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = withDesignDirectoryNameLease(root, initial.directory, () =>
      withDesignWorkspaceMutation(root, async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }),
    );
    await ready;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        service.handle(
          "design.page.select",
          {
            ...params,
            directoryId: initial.directoryId,
            pageId: "not_yet_in_catalog",
          },
          options,
        ),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Page select waited on authoring")),
            1_000,
          );
        }),
      ]);
      expect(result).toEqual({ ok: true });
      expect(service.isWriteOp("design.page.select")).toBe(false);
      expect(getDesignPageHint("local-main", root)).toEqual({
        directoryId: initial.directoryId,
        pageId: "not_yet_in_catalog",
      });
    } finally {
      clearTimeout(timer);
      release();
      await held;
    }
  });

  it("validates hint ownership, isolates checkout owners and never uses the hint for writes", async () => {
    const created = (await service.handle(
      "design.page.create",
      params,
      options,
    )) as { page: Snapshot["pages"][number] };
    await service.handle(
      "design.page.select",
      { ...params, directoryId: initial.directoryId, pageId: created.page.id },
      options,
    );
    expect(getDesignPageHint("local-main", root)).toMatchObject({
      pageId: created.page.id,
    });
    expect(getDesignPageHint("other-workspace", root)).toBeNull();
    expect(getDesignPageHint("local-main", root + "-other")).toBeNull();
    await expect(
      service.handle(
        "design.page.select",
        { ...params, directoryId: "design_wrong", pageId: created.page.id },
        options,
      ),
    ).rejects.toThrow(/directory.*not.*registered|directory.*missing/i);
    await expect(
      service.handle(
        "design.frame.create",
        { ...params, title: "Ambiguous" },
        options,
      ),
    ).rejects.toThrow(/pageId required/i);
    await expect(
      service.handle(
        "design.frame.create",
        { ...params, title: "Invalid", pageId: 123 },
        options,
      ),
    ).rejects.toThrow(/pageId|page.*ID|string/i);
  });

  it.each(["constructor", "__proto__"])(
    "rejects the unregistered hint owner %s",
    async (directoryId) => {
      await expect(
        service.handle(
          "design.page.select",
          { ...params, directoryId, pageId: initial.pages[0]!.id },
          options,
        ),
      ).rejects.toThrow(/directory.*not.*registered/i);
      expect(getDesignPageHint("local-main", root)).toBeNull();
    },
  );

  it("exposes the affected frame for structural undo/redo", async () => {
    const created = (await service.handle(
      "design.page.create",
      params,
      options,
    )) as { page: Snapshot["pages"][number] };
    const frame = (await service.handle(
      "design.frame.create",
      { ...params, title: "Home", pageId: created.page.id },
      options,
    )) as { frame: Snapshot["frames"][number] };
    const undo = (await service.handle(
      "design.history.undo",
      params,
      options,
    )) as { historyFrame?: string; snapshot: Snapshot };
    expect(undo.historyFrame).toBe(frame.frame.file);
    expect(undo.snapshot.frames).toEqual([]);
    const redo = (await service.handle(
      "design.history.redo",
      params,
      options,
    )) as { historyFrame?: string; snapshot: Snapshot };
    expect(redo.historyFrame).toBe(frame.frame.file);
    expect(redo.snapshot.frames[0]).toMatchObject({
      file: frame.frame.file,
      pageId: created.page.id,
    });
  });

  it("forwards page targets for text frames, duplicates and detach, including transfer history", async () => {
    const created = (await service.handle(
      "design.page.create",
      { ...params, title: "Checkout" },
      options,
    )) as { page: Snapshot["pages"][number] };
    const text = (await service.handle(
      "design.frame.create",
      {
        ...params,
        title: "Label",
        kind: "text",
        textNodeId: "label",
        text: "Hello",
        textFixedSize: false,
        pageId: created.page.id,
      },
      options,
    )) as { frame: Snapshot["frames"][number] };
    expect(text.frame).toMatchObject({
      file: "checkout/label.html",
      pageId: created.page.id,
    });
    const duplicate = (await service.handle(
      "design.frame.duplicate",
      { ...params, frame: text.frame.file, pageId: initial.pages[0]!.id },
      options,
    )) as { frame: Snapshot["frames"][number] };
    expect(duplicate.frame).toMatchObject({
      file: "page-1/label-copy.html",
      pageId: initial.pages[0]!.id,
    });
    const source = (await service.handle(
      "design.frame.create",
      {
        ...params,
        title: "Source",
        kind: "text",
        textNodeId: "source-label",
        text: "Move me",
        pageId: initial.pages[0]!.id,
      },
      options,
    )) as { frame: Snapshot["frames"][number] };
    const sourceRead = (await service.handle(
      "design.frame",
      { ...params, frame: source.frame.file },
      options,
    )) as { frame: { sourceVersion: string } };
    const transfer = (await service.handle(
      "design.node.transfer",
      {
        ...params,
        frame: source.frame.file,
        sourceVersion: sourceRead.frame.sourceVersion,
        nodeId: "source-label",
        pageId: created.page.id,
        x: 0,
        y: 0,
        w: 390,
        h: 844,
        z: 1,
      },
      options,
    )) as { frame: string; snapshot: Snapshot };
    expect(transfer.frame).toMatch(/^checkout\//);
    expect(
      transfer.snapshot.frames.find((frame) => frame.file === transfer.frame),
    ).toMatchObject({ pageId: created.page.id });
    const undo = (await service.handle(
      "design.history.undo",
      params,
      options,
    )) as { historyFrame: string };
    expect(undo.historyFrame).toBe(source.frame.file);
    const redo = (await service.handle(
      "design.history.redo",
      params,
      options,
    )) as { historyFrame: string };
    expect(redo.historyFrame).toBe(transfer.frame);
  });

  it("restores an empty deleted page before its earlier frame lifecycle entries", async () => {
    const created = (await service.handle(
      "design.page.create",
      params,
      options,
    )) as { page: Snapshot["pages"][number] };
    const frame = (await service.handle(
      "design.frame.create",
      { ...params, title: "Home", pageId: created.page.id },
      options,
    )) as { frame: Snapshot["frames"][number] };
    await service.handle(
      "design.frame.delete",
      { ...params, frame: frame.frame.file },
      options,
    );
    await service.handle(
      "design.page.delete",
      { ...params, pageId: created.page.id, expectedFrameIds: [] },
      options,
    );
    const call = (direction: "undo" | "redo") => service.handle(`design.history.${direction}`, params, options);
    const restoredPage = await call("undo") as { historyPageId?: string; snapshot: Snapshot };
    expect(restoredPage.historyPageId).toBe(created.page.id);
    expect(restoredPage.snapshot.pages).toContainEqual(created.page);
    expect(restoredPage.snapshot.frames).toEqual([]);
    expect(existsSync(path.join(root, initial.directory, created.page.folder))).toBe(true);
    expect(await call("undo")).toMatchObject({ historyFrame: frame.frame.file, snapshot: { frames: [{
      file: frame.frame.file, frameId: frame.frame.frameId, pageId: created.page.id,
    }] } });
    expect(existsSync(path.join(root, initial.directory, frame.frame.file))).toBe(true);
    await call("undo"); // Frame creation.
    expect(await call("undo")).toMatchObject({ result: null, snapshot: { pages: initial.pages, frames: [] } });
    await call("redo"); // Page creation.
    await call("redo"); // Frame creation.
    await call("redo"); // Frame deletion.
    expect(await call("redo")).toMatchObject({ result: null, snapshot: { pages: initial.pages, frames: [] } });
    expect(
      existsSync(path.join(root, initial.directory, created.page.folder)),
    ).toBe(false);
  });

  it("preserves semantic history for a frame removed with its page", async () => {
    const created = (await service.handle(
      "design.page.create",
      params,
      options,
    )) as { page: Snapshot["pages"][number] };
    const frame = (await service.handle(
      "design.frame.create",
      {
        ...params,
        title: "Label",
        kind: "text",
        textNodeId: "label",
        text: "Before",
        pageId: created.page.id,
      },
      options,
    )) as { frame: Snapshot["frames"][number] };
    const read = (await service.handle(
      "design.frame",
      { ...params, frame: frame.frame.file },
      options,
    )) as { frame: { sourceVersion: string } };
    await service.handle(
      "design.node.text",
      {
        ...params,
        frame: frame.frame.file,
        sourceVersion: read.frame.sourceVersion,
        nodeId: "label",
        text: "After",
      },
      options,
    );
    await service.handle(
      "design.page.delete",
      {
        ...params,
        pageId: created.page.id,
        expectedFrameIds: [frame.frame.frameId],
      },
      options,
    );
    const source = path.join(root, initial.directory, frame.frame.file);
    const call = (direction: "undo" | "redo") => service.handle(`design.history.${direction}`, params, options);
    expect(await call("undo")).toMatchObject({ historyPageId: created.page.id });
    expect(readFileSync(source, "utf8")).toContain("After");
    expect(await call("undo")).toMatchObject({ historyFrame: frame.frame.file });
    expect(readFileSync(source, "utf8")).toContain("Before");
    await call("redo");
    expect(readFileSync(source, "utf8")).toContain("After");
    expect(await call("redo")).toMatchObject({ result: null, snapshot: { pages: initial.pages, frames: [] } });
    expect(
      existsSync(path.join(root, initial.directory, created.page.folder)),
    ).toBe(false);
    expect(
      existsSync(path.join(root, initial.directory, frame.frame.file)),
    ).toBe(false);
  });
});
