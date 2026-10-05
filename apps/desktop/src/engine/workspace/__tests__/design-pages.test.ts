import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeState, setStateRootForTesting } from "../../git";
import { WorkspaceService } from "../service";
import { withDesignDirectoryNameLease } from "../../design/directory-registry";
import { withDesignWorkspaceMutation } from "../../design/document-write-lock";
import { getDesignPageHint } from "../../design/page-selection";
import { resetWorkspaceDesignApisForTests } from "../../design/design-api";

type Snapshot = { directoryId: string; directory: string; pages: Array<{ id: string; title: string; folder: string; frameFiles: string[] }>; frames: Array<{ file: string; pageId: string; frameId: string }> };

describe("page operations through WorkspaceService", () => {
  let root: string;
  let service: WorkspaceService;
  let initial: Snapshot;
  const params = { workspaceId: "local-main" };
  const options = { hostLocalResources: false };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-workspace-design-pages-"));
    setStateRootForTesting(path.join(root, "state"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    await writeFile(path.join(root, "code.txt"), "Code\n");
    git("add", "code.txt");
    git("commit", "-qm", "Fixture");
    service = new WorkspaceService(root, { primaryDesignWorkspace: true });
    initial = (await service.handle("design.initialize", params, options) as { snapshot: Snapshot }).snapshot;
  });
  afterEach(async () => {
    resetWorkspaceDesignApisForTests();
    closeState();
    await rm(root, { recursive: true, force: true });
  });

  it("returns a catalog/snapshot for page lifecycle while leaving history, HEAD and the index unchanged", async () => {
    const head = git("rev-parse", "HEAD");
    const index = readFileSync(path.join(root, ".git/index"));
    const created = await service.handle("design.page.create", { ...params, directoryId: initial.directoryId, title: "Checkout" }, options) as { page: Snapshot["pages"][number]; snapshot: Snapshot };
    expect(created.page).toMatchObject({ title: "Checkout", folder: "checkout", frameFiles: [] });
    expect(created.snapshot.pages).toHaveLength(2);
    const renamed = await service.handle("design.page.rename", { ...params, pageId: created.page.id, title: "Purchase" }, options) as { page: Snapshot["pages"][number]; snapshot: Snapshot };
    expect(renamed.page).toMatchObject({ id: created.page.id, title: "Purchase", folder: "checkout" });
    const deleted = await service.handle("design.page.delete", { ...params, pageId: created.page.id, expectedFrameIds: [] }, options) as { deleted: { pageId: string }; snapshot: Snapshot };
    expect(deleted).toMatchObject({ deleted: { pageId: created.page.id }, snapshot: { pages: initial.pages } });
    expect(service.lifecycleMutationWorkspaceId("design.page.create", params)).toBe("local-main");
    expect(service.lifecycleMutationWorkspaceId("design.page.select", params)).toBeNull();
    const undo = await service.handle("design.history.undo", params, options) as { result: unknown; snapshot: Snapshot };
    expect(undo.result).toBeNull();
    expect(undo.snapshot.pages).toEqual(initial.pages);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(path.join(root, ".git/index"))).toEqual(index);
  });

  it("requires captured directory ownership and confirmed membership", async () => {
    await expect(service.handle("design.page.create", { ...params, directoryId: "design_wrong" }, options)).rejects.toThrow(/directory.*changed/i);
    const created = await service.handle("design.page.create", params, options) as { page: Snapshot["pages"][number] };
    const frame = await service.handle("design.frame.create", { ...params, title: "Home", pageId: created.page.id }, options) as { frame: Snapshot["frames"][number]; snapshot: Snapshot };
    expect(frame.frame).toMatchObject({ file: "page-2/home.html", pageId: created.page.id });
    await expect(service.handle("design.page.delete", { ...params, pageId: created.page.id, expectedFrameIds: [] }, options)).rejects.toThrow(/membership.*changed/i);
    await service.handle("design.page.delete", { ...params, pageId: created.page.id, expectedFrameIds: [frame.frame.frameId] }, options);
    expect(existsSync(path.join(root, initial.directory, frame.frame.file))).toBe(false);
  });

  it("does not reuse a snapshot flight started before a page mutation", async () => {
    // The in-flight read belongs to the same exact key but predates this write.
    const host = service as unknown as { designSnapshotFlights: Map<string, Promise<Snapshot>> };
    const key = `local-main\u0000${root}\u0000read\u0000${initial.directory}\u0000bridge-resources`;
    host.designSnapshotFlights.set(key, Promise.resolve(initial));
    try {
      const created = await service.handle("design.page.create", { ...params, title: "Checkout" }, options) as { page: Snapshot["pages"][number]; snapshot: Snapshot };
      expect(created.snapshot.pages).toHaveLength(2);
      expect(created.snapshot.pages.find(page => page.id === created.page.id)).toEqual(created.page);
    } finally {
      host.designSnapshotFlights.delete(key);
    }
  });

  it("keeps the page mutation lane through its confirmed snapshot while select remains immediate", async () => {
    const created = await service.handle("design.page.create", { ...params, title: "Checkout" }, options) as { page: Snapshot["pages"][number] };
    const host = service as unknown as { readDesignSnapshot: (...args: unknown[]) => Promise<Snapshot> };
    const readSnapshot = host.readDesignSnapshot.bind(service);
    let release!: () => void;
    let entered!: () => void;
    let overlapped!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const overlap = new Promise<string>(resolve => { overlapped = () => resolve("overlap"); });
    let calls = 0;
    const spy = vi.spyOn(host, "readDesignSnapshot").mockImplementation(async (...args) => {
      if (++calls === 1) {
        entered();
        await new Promise<void>(resolve => { release = resolve; });
      } else overlapped();
      return readSnapshot(...args);
    });
    const first = service.handle("design.page.rename", { ...params, pageId: created.page.id, title: "First" }, options);
    let second: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await ready;
      second = service.handle("design.page.rename", { ...params, pageId: created.page.id, title: "Second" }, options);
      const state = await Promise.race([overlap, new Promise<string>(resolve => { timer = setTimeout(() => resolve("serialized"), 500); })]);
      expect(state).toBe("serialized");
      expect(await service.handle("design.page.select", { ...params, directoryId: initial.directoryId, pageId: created.page.id }, options)).toEqual({ ok: true });
      release();
      const replies = await Promise.all([first, second]) as Array<{ page: Snapshot["pages"][number]; snapshot: Snapshot }>;
      expect(replies.map(reply => reply.page.title)).toEqual(["First", "Second"]);
      for (const reply of replies) expect(reply.snapshot.pages.find(page => page.id === created.page.id)).toEqual(reply.page);
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
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = withDesignDirectoryNameLease(root, initial.directory, () => withDesignWorkspaceMutation(root, async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    }));
    await ready;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        service.handle("design.page.select", { ...params, directoryId: initial.directoryId, pageId: "not_yet_in_catalog" }, options),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Page select waited on authoring")), 1_000); }),
      ]);
      expect(result).toEqual({ ok: true });
      expect(service.isWriteOp("design.page.select")).toBe(false);
      expect(getDesignPageHint("local-main", root)).toEqual({ directoryId: initial.directoryId, pageId: "not_yet_in_catalog" });
    } finally {
      clearTimeout(timer);
      release();
      await held;
    }
  });

  it("validates hint ownership, isolates checkout owners and never uses the hint for writes", async () => {
    const created = await service.handle("design.page.create", params, options) as { page: Snapshot["pages"][number] };
    await service.handle("design.page.select", { ...params, directoryId: initial.directoryId, pageId: created.page.id }, options);
    expect(getDesignPageHint("local-main", root)).toMatchObject({ pageId: created.page.id });
    expect(getDesignPageHint("other-workspace", root)).toBeNull();
    expect(getDesignPageHint("local-main", root + "-other")).toBeNull();
    await expect(service.handle("design.page.select", { ...params, directoryId: "design_wrong", pageId: created.page.id }, options)).rejects.toThrow(/directory.*not.*registered|directory.*missing/i);
    await expect(service.handle("design.frame.create", { ...params, title: "Ambiguous" }, options)).rejects.toThrow(/pageId required/i);
    await expect(service.handle("design.frame.create", { ...params, title: "Invalid", pageId: 123 }, options)).rejects.toThrow(/pageId|page.*ID|string/i);
  });

  it.each(["constructor", "__proto__"])("rejects the unregistered hint owner %s", async directoryId => {
    await expect(service.handle("design.page.select", { ...params, directoryId, pageId: initial.pages[0]!.id }, options)).rejects.toThrow(/directory.*not.*registered/i);
    expect(getDesignPageHint("local-main", root)).toBeNull();
  });

  it("exposes the affected frame for structural undo/redo", async () => {
    const created = await service.handle("design.page.create", params, options) as { page: Snapshot["pages"][number] };
    const frame = await service.handle("design.frame.create", { ...params, title: "Home", pageId: created.page.id }, options) as { frame: Snapshot["frames"][number] };
    const undo = await service.handle("design.history.undo", params, options) as { historyFrame?: string; snapshot: Snapshot };
    expect(undo.historyFrame).toBe(frame.frame.file);
    expect(undo.snapshot.frames).toEqual([]);
    const redo = await service.handle("design.history.redo", params, options) as { historyFrame?: string; snapshot: Snapshot };
    expect(redo.historyFrame).toBe(frame.frame.file);
    expect(redo.snapshot.frames[0]).toMatchObject({ file: frame.frame.file, pageId: created.page.id });
  });

  it("forwards page targets for text frames, duplicates and detach, including transfer history", async () => {
    const created = await service.handle("design.page.create", { ...params, title: "Checkout" }, options) as { page: Snapshot["pages"][number] };
    const text = await service.handle("design.frame.create", { ...params, title: "Label", kind: "text", textNodeId: "label", text: "Hello", textFixedSize: false, pageId: created.page.id }, options) as { frame: Snapshot["frames"][number] };
    expect(text.frame).toMatchObject({ file: "checkout/label.html", pageId: created.page.id });
    const duplicate = await service.handle("design.frame.duplicate", { ...params, frame: text.frame.file, pageId: initial.pages[0]!.id }, options) as { frame: Snapshot["frames"][number] };
    expect(duplicate.frame).toMatchObject({ file: "page-1/label-copy.html", pageId: initial.pages[0]!.id });
    const source = await service.handle("design.frame.create", { ...params, title: "Source", kind: "text", textNodeId: "source-label", text: "Move me", pageId: initial.pages[0]!.id }, options) as { frame: Snapshot["frames"][number] };
    const sourceRead = await service.handle("design.frame", { ...params, frame: source.frame.file }, options) as { frame: { sourceVersion: string } };
    const transfer = await service.handle("design.node.transfer", { ...params, frame: source.frame.file, sourceVersion: sourceRead.frame.sourceVersion, nodeId: "source-label", pageId: created.page.id, x: 0, y: 0, w: 390, h: 844, z: 1 }, options) as { frame: string; snapshot: Snapshot };
    expect(transfer.frame).toMatch(/^checkout\//);
    expect(transfer.snapshot.frames.find(frame => frame.file === transfer.frame)).toMatchObject({ pageId: created.page.id });
    const undo = await service.handle("design.history.undo", params, options) as { historyFrame: string };
    expect(undo.historyFrame).toBe(source.frame.file);
    const redo = await service.handle("design.history.redo", params, options) as { historyFrame: string };
    expect(redo.historyFrame).toBe(transfer.frame);
  });

  it("fails stale undo after page deletion without recreating that page's folder or files", async () => {
    const created = await service.handle("design.page.create", params, options) as { page: Snapshot["pages"][number] };
    const frame = await service.handle("design.frame.create", { ...params, title: "Home", pageId: created.page.id }, options) as { frame: Snapshot["frames"][number] };
    await service.handle("design.frame.delete", { ...params, frame: frame.frame.file }, options);
    await service.handle("design.page.delete", { ...params, pageId: created.page.id, expectedFrameIds: [] }, options);
    await expect(service.handle("design.history.undo", params, options)).rejects.toThrow(/page.*not found|page.*removed|page.*missing/i);
    expect(existsSync(path.join(root, initial.directory, created.page.folder))).toBe(false);
  });

  it("fails semantic history for a frame removed with its page without recreating source", async () => {
    const created = await service.handle("design.page.create", params, options) as { page: Snapshot["pages"][number] };
    const frame = await service.handle("design.frame.create", { ...params, title: "Label", kind: "text", textNodeId: "label", text: "Before", pageId: created.page.id }, options) as { frame: Snapshot["frames"][number] };
    const read = await service.handle("design.frame", { ...params, frame: frame.frame.file }, options) as { frame: { sourceVersion: string } };
    await service.handle("design.node.text", { ...params, frame: frame.frame.file, sourceVersion: read.frame.sourceVersion, nodeId: "label", text: "After" }, options);
    await service.handle("design.page.delete", { ...params, pageId: created.page.id, expectedFrameIds: [frame.frame.frameId] }, options);
    await expect(service.handle("design.history.undo", params, options)).rejects.toThrow(/page|frame.*not found|missing/i);
    expect(existsSync(path.join(root, initial.directory, created.page.folder))).toBe(false);
    expect(existsSync(path.join(root, initial.directory, frame.frame.file))).toBe(false);
  });
});
