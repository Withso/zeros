import { useLegacyDesignStorage } from "./storage-fixtures";
import { mkdir, mkdtemp, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initializeDesignDocument,
  listDesignFrames,
  readDesignFrame,
  readDesignWorkspaceSnapshot,
  readDesignElementOffsetMap,
  setDesignNodeText,
  updateDesignFrameGeometry,
  createDesignFrame,
  deleteDesignFrame,
  DESIGN_DIRECTORY_NAME,
} from "../document";
import { parseDesignManifest, serializeDesignManifest } from "../manifest";
import {
  designDocumentMetadataPath,
  ensureDesignMetadataLayout,
} from "../metadata";
import { decodeCanvasFile } from "../canvas-file";
import {
  getWorkspaceDesignApi,
  resetWorkspaceDesignApisForTests,
} from "../design-api";

describe("native Design file authoring", () => {
  let root: string;
  let folder: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-native-design-"));
    folder = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
  });
  afterEach(async () => {
    resetWorkspaceDesignApisForTests();
    await rm(root, { recursive: true, force: true });
  });

  async function author() {
    const canvasPath = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
    canvas.frames.home = {
      kind: "html",
      source: "page-1/home.html",
      title: "Home",
      x: 0,
      y: 0,
      width: 390,
      height: 844,
    };
    canvas.pages[0].frames.push("home");
    const html =
      "<!doctype html><html><body><main><h1>Hello</h1></main></body></html>";
    await writeFile(path.join(folder, "page-1/home.html"), html);
    await writeFile(canvasPath, JSON.stringify(canvas));
    return { canvas, html, canvasPath };
  }

  it("creates registration-only metadata and discovers native source without an API apply", async () => {
    const manifest = parseDesignManifest(
      await readFile(path.join(folder, "meta/design.toml"), "utf8"),
    );
    expect(manifest).toMatchObject({ canvas: "canvas.json" });
    expect(manifest?.document).toBeUndefined();
    expect(designDocumentMetadataPath(root, DESIGN_DIRECTORY_NAME)).toBe(
      path.join(folder, "meta/canvas.json"),
    );
    const { html } = await author();
    const frames = await listDesignFrames(root, { writeBack: false });
    expect(frames).toMatchObject([
      { file: "page-1/home.html", title: "Home", width: 390, height: 844 },
    ]);
    expect(await readFile(path.join(folder, "page-1/home.html"), "utf8")).toBe(html);
    await writeFile(
      path.join(folder, "page-1/home.html"),
      html.replace("Hello", "Updated"),
    );
    expect(
      (await readDesignFrame(root, "page-1/home.html", 4, { writeBack: false }))
        .source,
    ).toContain("Updated");
  });

  it("keeps unregistered HTML as source and writes visual geometry to the same canvas", async () => {
    const { canvasPath } = await author();
    await writeFile(path.join(folder, "template.html"), "<p>Not a frame</p>");
    expect(
      (await listDesignFrames(root, { writeBack: false })).map(
        (frame) => frame.file,
      ),
    ).toEqual(["page-1/home.html"]);
    await updateDesignFrameGeometry(root, "page-1/home.html", { x: 500 });
    expect(JSON.parse(await readFile(canvasPath, "utf8")).frames.home.x).toBe(
      500,
    );
  });

  it("reads a page added through native source tools without an API page operation", async () => {
    const { canvas, canvasPath } = await author();
    canvas.pages.push({ id: "checkout", title: "Checkout", folder: "checkout", frames: ["checkout_home"] });
    canvas.frames.checkout_home = { ...canvas.frames.home, source: "checkout/home.html", title: "Checkout" };
    await mkdir(path.join(folder, "checkout"));
    await writeFile(path.join(folder, "checkout/home.html"), '<link rel="stylesheet" href="../tokens.css"><h1>Checkout</h1>');
    await writeFile(canvasPath, JSON.stringify(canvas));
    const before = await readFile(canvasPath, "utf8");
    const snapshot = await readDesignWorkspaceSnapshot(root);
    expect(snapshot.pages).toMatchObject([{ id: canvas.pages[0].id, frameFiles: ["page-1/home.html"] }, { id: "checkout", frameFiles: ["checkout/home.html"] }]);
    expect(snapshot.frames).toEqual(expect.arrayContaining([expect.objectContaining({ file: "checkout/home.html", pageId: "checkout", frameId: "checkout_home" })]));
    expect(await readFile(canvasPath, "utf8")).toBe(before);
  });

  it("renders and selects plain HTML without rewriting it, then visually edits the same source", async () => {
    const { html, canvasPath } = await author();
    const canvasBefore = await readFile(canvasPath, "utf8");
    const snapshot = await readDesignWorkspaceSnapshot(root);
    const frame = await readDesignFrame(root, "page-1/home.html");
    expect(await readFile(path.join(folder, "page-1/home.html"), "utf8")).toBe(html);
    expect(await readFile(canvasPath, "utf8")).toBe(canvasBefore);
    expect(
      snapshot.lint.violations.some((v) => v.ruleId === "oid-missing"),
    ).toBe(false);
    const heading = frame.tree[0].children[0];
    expect(heading.oid).toBeTruthy();
    const offsets = await readDesignElementOffsetMap(root, "page-1/home.html");
    const offset = offsets.find((entry) => entry.oid === heading.oid)!;
    expect(html.slice(offset.startOffset, offset.endOffset)).toBe(
      "<h1>Hello</h1>",
    );
    await setDesignNodeText(root, {
      frame: "page-1/home.html",
      nodeId: heading.oid!,
      sourceVersion: frame.sourceVersion,
      text: "Visual edit",
    });
    expect(await readFile(path.join(folder, "page-1/home.html"), "utf8")).toContain(
      "Visual edit",
    );
    await writeFile(
      path.join(folder, "page-1/home.html"),
      html.replace("Hello", "Native edit"),
    );
    await expect(
      setDesignNodeText(root, {
        frame: "page-1/home.html",
        nodeId: heading.oid!,
        sourceVersion: frame.sourceVersion,
        text: "Stale",
      }),
    ).rejects.toThrow(/changed/);
    expect(await readFile(path.join(folder, "page-1/home.html"), "utf8")).toContain(
      "Native edit",
    );
  });

  it("preserves identity on native rename and does not erase missing references", async () => {
    const { canvasPath, canvas } = await author();
    await rename(
      path.join(folder, "page-1/home.html"),
      path.join(folder, "page-1/welcome.html"),
    );
    await expect(listDesignFrames(root, { writeBack: false })).rejects.toThrow(
      /home.html|missing/i,
    );
    expect(
      JSON.parse(await readFile(canvasPath, "utf8")).frames.home,
    ).toBeDefined();
    canvas.frames.home.source = "page-1/welcome.html";
    await writeFile(canvasPath, JSON.stringify(canvas));
    expect((await listDesignFrames(root, { writeBack: false }))[0].file).toBe(
      "page-1/welcome.html",
    );
  });

  it("assigns a fresh canvas identity when a deleted source filename is reused", async () => {
    const original = await createDesignFrame(root, { title: "Reusable" });
    const first = JSON.parse(
      await readFile(path.join(folder, "meta/canvas.json"), "utf8"),
    );
    await deleteDesignFrame(root, original.file);
    const replacement = await createDesignFrame(root, { title: "Reusable" });
    const second = JSON.parse(
      await readFile(path.join(folder, "meta/canvas.json"), "utf8"),
    );
    expect(replacement.file).toBe(original.file);
    expect(Object.keys(second.frames)).not.toEqual(Object.keys(first.frames));
  });

  it("lets optional inspection and semantic tools use native HTML without a repair pass", async () => {
    const { html } = await author();
    const api = getWorkspaceDesignApi(root);
    const opened = await api.open("frame:page-1/home.html");
    const inspected = await api.readProjection({
      documentId: "frame:page-1/home.html",
    });
    expect(inspected.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "identity-missing" }),
      ]),
    );
    const heading = inspected.nodes.find((node) => node.tag === "h1")!;
    expect(heading.id).toBe(
      (await readDesignFrame(root, "page-1/home.html")).tree[0].children[0].oid,
    );
    await api.readProvenance({
      documentId: "frame:page-1/home.html",
      nodeId: heading.id,
      property: "color",
    });
    expect(await readFile(path.join(folder, "page-1/home.html"), "utf8")).toBe(html);
    await api.apply({
      schemaVersion: 1,
      actor: { kind: "human", id: "tester" },
      intent: "Edit heading",
      createdAt: 1,
      transactionId: "native-semantic",
      documentId: "frame:page-1/home.html",
      baseRevision: opened.revision,
      operations: [
        {
          operationId: "text",
          type: "node.set-text",
          nodeId: heading.id,
          text: "Semantic edit",
        },
      ],
    });
    expect(await readFile(path.join(folder, "page-1/home.html"), "utf8")).toContain(
      "Semantic edit",
    );
    await api.undo("frame:page-1/home.html");
    expect(await readFile(path.join(folder, "page-1/home.html"), "utf8")).toBe(html);
  });

  it("reads an old branch without migrating and explicitly migrates with its identity intact", async () => {
    await author();
    const { id, document } = useLegacyDesignStorage(root, DESIGN_DIRECTORY_NAME, ".zeros/design-dir.toml");
    await rm(path.join(root, ".zeros"), { recursive: true });
    const manifestPath = path.join(folder, "design.toml");
    const canvasPath = path.join(folder, "canvas.json");
    const legacy = serializeDesignManifest(id, document);
    await writeFile(manifestPath, legacy);
    expect((await listDesignFrames(root, { writeBack: false }))[0].file).toBe("home.html");
    expect(await readFile(manifestPath, "utf8")).toBe(legacy);
    ensureDesignMetadataLayout(root, DESIGN_DIRECTORY_NAME);
    expect(parseDesignManifest(await readFile(manifestPath, "utf8"))).toEqual({ version: 2, id, canvas: "canvas.json" });
    expect(decodeCanvasFile(await readFile(canvasPath, "utf8"))).toMatchObject(document);
    await initializeDesignDocument(root);
    expect(parseDesignManifest(await readFile(path.join(folder, "meta/design.toml"), "utf8"))).toMatchObject({ version: 3, id });
    expect((await listDesignFrames(root, { writeBack: false }))[0].file).toBe("page-1/home.html");
    const migrated = JSON.parse(await readFile(path.join(folder, "meta/canvas.json"), "utf8"));
    expect(migrated.frames.home.source).toBe("page-1/home.html");
  });
});
