import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeState, setStateRootForTesting } from "../../git";
import { insertWorkspace } from "../../git/state";
import { WorkspaceService } from "../service";
import { resetWorkspaceDesignApisForTests } from "../../design/design-api";

type Item = { id: string; kind: string; x: number; y: number; width: number; height?: number; text?: string; target?: string; title?: string; missing?: true };
type Page = { id: string; title: string; folder: string; frameFiles: string[]; frameIds?: string[]; items?: Item[]; itemsNotShown?: number };
type Snapshot = { directoryId: string; directory: string; pages: Page[]; lint: { violations: Array<{ ruleId: string; severity: string }> } };
type Reply = { item?: Item; deleted?: { id: string }; snapshot: Snapshot; historyPageId?: string; historyItemId?: string | null; historySelection?: string | null };

describe("canvas items through WorkspaceService", () => {
  let root: string;
  let service: WorkspaceService;
  let initial: Snapshot;
  let pageId: string;
  const params = { workspaceId: "local-main" };
  const options = { hostLocalResources: false };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const call = (op: string, extra: Record<string, unknown> = {}) => service.handle(op, { ...params, ...extra }, options) as Promise<Reply>;
  const canvasFile = () => path.join(root, initial.directory, "meta/canvas.json");
  const authored = () => JSON.parse(readFileSync(canvasFile(), "utf8")) as { pages: Array<{ id: string; items?: unknown[] }> };
  const pageItems = (snapshot: Snapshot) => snapshot.pages.find((page) => page.id === pageId)?.items;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-workspace-design-items-"));
    setStateRootForTesting(path.join(root, "state"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    await writeFile(path.join(root, "code.txt"), "Code\n");
    git("add", "code.txt");
    git("commit", "-qm", "Fixture");
    service = new WorkspaceService(root);
    insertWorkspace(service["localMainEntry"]());
    initial = ((await service.handle("design.initialize", params, options)) as { snapshot: Snapshot }).snapshot;
    pageId = initial.pages[0]!.id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resetWorkspaceDesignApisForTests();
    closeState();
    await rm(root, { recursive: true, force: true });
  });

  it("places, moves and deletes an item, each one undo step, without touching HEAD or the index", async () => {
    const head = git("rev-parse", "HEAD");
    const index = readFileSync(path.join(root, ".git/index"));
    expect(pageItems(initial)).toBeUndefined();
    const created = await call("design.canvas.item.put", { pageId, item: { kind: "section", x: 10, y: -60, width: 400, text: "Onboarding" } });
    expect(created.item).toMatchObject({ kind: "section", text: "Onboarding" });
    expect(created.item!.id).toMatch(/^item_[a-f0-9]{16}$/);
    const id = created.item!.id;
    expect(pageItems(created.snapshot)).toEqual([created.item]);
    expect(authored().pages.find((page) => page.id === pageId)!.items).toEqual([created.item]);

    const moved = await call("design.canvas.item.put", { pageId, item: { ...created.item, x: 200, y: 40 } });
    expect(pageItems(moved.snapshot)).toEqual([{ ...created.item, x: 200, y: 40 }]);
    const deleted = await call("design.canvas.item.delete", { pageId, itemId: id });
    expect(deleted.deleted).toEqual({ id });
    expect(pageItems(deleted.snapshot)).toBeUndefined();

    const restoredDelete = await call("design.history.undo");
    expect(pageItems(restoredDelete.snapshot)).toEqual([{ ...created.item, x: 200, y: 40 }]);
    expect(restoredDelete).toMatchObject({ historyPageId: pageId, historyItemId: id, historySelection: null });
    const restoredMove = await call("design.history.undo");
    expect(pageItems(restoredMove.snapshot)).toEqual([created.item]);
    expect(restoredMove).toMatchObject({ historyPageId: pageId, historyItemId: id, historySelection: null });
    const undoneCreate = await call("design.history.undo");
    expect(pageItems(undoneCreate.snapshot)).toBeUndefined();
    expect(undoneCreate).toMatchObject({ historyPageId: pageId, historyItemId: null, historySelection: null });
    const redoneCreate = await call("design.history.redo");
    expect(pageItems(redoneCreate.snapshot)).toEqual([created.item]);
    expect(redoneCreate).toMatchObject({ historyPageId: pageId, historyItemId: id, historySelection: null });
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(path.join(root, ".git/index"))).toEqual(index);
  });

  it("keeps an item's authored extras, unknown kinds and invalid entries through a write", async () => {
    const written = authored();
    const page = written.pages.find((candidate) => candidate.id === pageId)!;
    page.items = [
      JSON.parse('{ "id": "n1", "kind": "note", "x": 0, "y": 0, "width": 200, "height": 100, "text": "Hello", "extra": { "keep": true }, "__proto__": { "own": 1 } }'),
      { id: "u1", kind: "sticker", x: 0, y: 0, emoji: "star" },
      { id: "bad1", kind: "section", x: 0, y: 0, width: 200, text: "" },
    ];
    await writeFile(canvasFile(), JSON.stringify(written));
    const read = (await service.handle("design.snapshot", params, options)) as { snapshot: Snapshot };
    expect(pageItems(read.snapshot)).toEqual([{ id: "n1", kind: "note", x: 0, y: 0, width: 200, height: 100, text: "Hello" }]);
    // Items never block the canvas: its own lint does not list them.
    expect(read.snapshot.lint.violations.some((violation) => violation.ruleId.startsWith("canvas-item"))).toBe(false);

    await call("design.canvas.item.put", { pageId, item: { id: "n1", kind: "note", x: 50, y: 0, width: 200, height: 100, text: "Hello\nthere" } });
    expect(authored().pages.find((candidate) => candidate.id === pageId)!.items).toEqual([
      JSON.parse('{ "id": "n1", "kind": "note", "x": 50, "y": 0, "width": 200, "height": 100, "text": "Hello\\nthere", "extra": { "keep": true }, "__proto__": { "own": 1 } }'),
      { id: "u1", kind: "sticker", x: 0, y: 0, emoji: "star" },
      { id: "bad1", kind: "section", x: 0, y: 0, width: 200, text: "" },
    ]);
    // A kept entry's id stays taken; an invalid entry cannot be changed here.
    await expect(call("design.canvas.item.put", { pageId, item: { id: "bad1", kind: "section", x: 0, y: 0, width: 200, text: "Fixed" } }))
      .rejects.toThrow(/not on this page/);
    await expect(call("design.canvas.item.delete", { pageId, itemId: "u1" })).rejects.toThrow(/not on this page/);
    // An authored "__proto__" field is kept as an own field, never a prototype.
    const kept = authored().pages.find((candidate) => candidate.id === pageId)!.items![0] as object;
    expect(Object.hasOwn(kept, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
  });

  it("names the affected second page and actual generated item in both history directions", async () => {
    const createdPage = await service.handle("design.page.create", { ...params, title: "Second" }, options) as { page: Page };
    const created = await call("design.canvas.item.put", { pageId: createdPage.page.id,
      item: { kind: "note", x: 0, y: 0, width: 200, height: 100, text: "Cross-page" } });
    const id = created.item!.id;
    const undone = await call("design.history.undo");
    expect(undone).toMatchObject({ historyPageId: createdPage.page.id, historyItemId: null, historySelection: null });
    expect(undone.snapshot.pages.find(page => page.id === createdPage.page.id)?.items).toBeUndefined();
    const redone = await call("design.history.redo");
    expect(redone).toMatchObject({ historyPageId: createdPage.page.id, historyItemId: id, historySelection: null });
    expect(redone.snapshot.pages.find(page => page.id === createdPage.page.id)?.items).toEqual([created.item]);
  });

  it("refuses an unsafe link, an unknown field, a changed kind and a page past its caps", async () => {
    await expect(call("design.canvas.item.put", { pageId, item: { kind: "link", x: 0, y: 0, width: 240, target: "../outside.md" } }))
      .rejects.toThrow(/\.\./);
    await expect(call("design.canvas.item.put", { pageId, item: { kind: "link", x: 0, y: 0, width: 240, target: ".env" } }))
      .rejects.toThrow(/private/);
    await expect(call("design.canvas.item.put", { pageId, item: { kind: "note", x: 0, y: 0, width: 200, height: 80, text: "", color: "yellow" } }))
      .rejects.toThrow(/no "color" field/);
    const section = (await call("design.canvas.item.put", { pageId, item: { kind: "section", x: 0, y: 0, width: 200, text: "One" } })).item!;
    await expect(call("design.canvas.item.put", { pageId, item: { id: section.id, kind: "note", x: 0, y: 0, width: 200, height: 80, text: "" } }))
      .rejects.toThrow(/keeps its kind/);
    const written = authored();
    written.pages.find((candidate) => candidate.id === pageId)!.items = Array.from({ length: 256 }, (_, index) =>
      ({ id: `s${index}`, kind: "section", x: 0, y: index * 40, width: 200, text: "Section" }));
    await writeFile(canvasFile(), JSON.stringify(written));
    await expect(call("design.canvas.item.put", { pageId, item: { kind: "section", x: 0, y: 0, width: 200, text: "Too many" } }))
      .rejects.toThrow(/at most 256 items/);
    await expect(call("design.canvas.item.put", { pageId: "missing_page", item: { kind: "section", x: 0, y: 0, width: 200, text: "x" } }))
      .rejects.toThrow(/not found/);
  });

  it("reports how many valid items are not shown beyond the page cap", async () => {
    const written = authored();
    written.pages.find((candidate) => candidate.id === pageId)!.items = Array.from({ length: 258 }, (_, index) =>
      ({ id: `s${index}`, kind: "section", x: 0, y: index * 40, width: 200, text: "Section" }));
    await writeFile(canvasFile(), JSON.stringify(written));
    const read = (await service.handle("design.snapshot", params, options)) as { snapshot: Snapshot };
    const page = read.snapshot.pages.find((candidate) => candidate.id === pageId)!;
    expect(page.items).toHaveLength(256);
    expect(page.itemsNotShown).toBe(2);
  });

  it("treats only regular files contained by the workspace as link targets", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "zeros-design-items-outside-"));
    try {
      await mkdir(path.join(root, "docs"));
      await writeFile(path.join(root, "docs/spec.md"), "# Inside\n");
      await writeFile(path.join(outside, "outside.md"), "# Outside\n");
      await symlink("spec.md", path.join(root, "docs/inside-link.md"));
      await symlink(path.join(outside, "outside.md"), path.join(root, "docs/escaping-link.md"));
      await symlink("absent.md", path.join(root, "docs/dangling-link.md"));
      const ordinary = (await call("design.canvas.item.put", { pageId, item: { kind: "link", x: 0, y: 0, width: 240, target: "docs/spec.md" } })).item!;
      const inside = (await call("design.canvas.item.put", { pageId, item: { kind: "link", x: 0, y: 60, width: 240, target: "docs/inside-link.md" } })).item!;
      const escaping = (await call("design.canvas.item.put", { pageId, item: { kind: "link", x: 0, y: 120, width: 240, target: "docs/escaping-link.md" } })).item!;
      const read = await call("design.canvas.item.put", { pageId, item: { kind: "link", x: 0, y: 180, width: 240, target: "docs/dangling-link.md" } });
      const dangling = read.item!;
      expect(pageItems(read.snapshot)?.map((item) => [item.id, item.missing === true])).toEqual([
        [ordinary.id, false], [inside.id, false], [escaping.id, true], [dangling.id, true],
      ]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  describe("an earlier malformed entry with the drawn item's id", () => {
    const malformed = { id: "dup1", kind: "section", x: 0, y: 0, width: 200, text: "", authorNote: "fix me" };
    const drawn = { id: "dup1", kind: "section", x: 0, y: 40, width: 200, text: "Drawn", extra: { keep: true } };
    const entries = () => authored().pages.find((candidate) => candidate.id === pageId)!.items!.map((entry) => JSON.stringify(entry));
    beforeEach(async () => {
      const written = authored();
      written.pages.find((candidate) => candidate.id === pageId)!.items = [malformed, drawn];
      await writeFile(canvasFile(), JSON.stringify(written));
      const read = (await service.handle("design.snapshot", params, options)) as { snapshot: Snapshot };
      expect(pageItems(read.snapshot)).toEqual([{ id: "dup1", kind: "section", x: 0, y: 40, width: 200, text: "Drawn" }]);
    });

    it("is kept as written when the drawn item is edited, and the drawn entry's extras survive", async () => {
      const moved = { id: "dup1", kind: "section", x: 50, y: 40, width: 200, text: "Moved" };
      const edited = await call("design.canvas.item.put", { pageId, item: moved });
      expect(pageItems(edited.snapshot)).toEqual([moved]);
      expect(entries()).toEqual([JSON.stringify(malformed), JSON.stringify({ extra: { keep: true }, ...moved })]);
    });

    it("is kept as written when the drawn item is deleted", async () => {
      const deleted = await call("design.canvas.item.delete", { pageId, itemId: "dup1" });
      expect(pageItems(deleted.snapshot)).toBeUndefined();
      expect(entries()).toEqual([JSON.stringify(malformed)]);
    });
  });
  it("marks a link card whose file is missing, and reports items in design validate", async () => {
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs/spec.md"), "# Spec\n");
    const present = (await call("design.canvas.item.put", { pageId, item: { kind: "link", x: 0, y: 0, width: 240, target: "docs/spec.md" } })).item!;
    const gone = await call("design.canvas.item.put", { pageId, item: { kind: "link", x: 0, y: 80, width: 240, target: "docs/gone.md", title: "Gone" } });
    expect(pageItems(gone.snapshot)).toEqual([present, { ...gone.item, missing: true }]);
    const written = authored();
    written.pages.find((candidate) => candidate.id === pageId)!.items!.push(
      { id: "l9", kind: "link", x: 0, y: 0, width: 240, target: "../../etc/passwd" },
      { id: "s9", kind: "section", x: 0, y: 0, width: 200, text: "a\nb" },
    );
    await writeFile(canvasFile(), JSON.stringify(written));
    const lint = (await service.handle("design.lint", params, options)) as { report: { violations: Array<{ ruleId: string; severity: string; file: string; message: string }> } };
    const items = lint.report.violations.filter((violation) => violation.ruleId.startsWith("canvas-item"));
    expect(items.map((violation) => violation.ruleId).sort()).toEqual(["canvas-item-invalid", "canvas-item-link-missing", "canvas-item-link-unsafe"]);
    expect(items.every((violation) => violation.severity === "warning" && violation.file === "meta/canvas.json")).toBe(true);
    // A link's existence is a local stat only; the file is never read into the snapshot.
    expect(JSON.stringify(gone.snapshot)).not.toContain("# Spec");
  });
});
