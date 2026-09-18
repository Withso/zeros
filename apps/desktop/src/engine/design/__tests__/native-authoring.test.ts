import { mkdtemp, readFile, writeFile, rm, rename } from "node:fs/promises";
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
    const canvasPath = path.join(folder, "canvas.json");
    const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
    canvas.frames.home = {
      kind: "html",
      source: "home.html",
      title: "Home",
      x: 0,
      y: 0,
      width: 390,
      height: 844,
    };
    canvas.pages[0].frames.push("home");
    const html =
      "<!doctype html><html><body><main><h1>Hello</h1></main></body></html>";
    await writeFile(path.join(folder, "home.html"), html);
    await writeFile(canvasPath, JSON.stringify(canvas));
    return { canvas, html, canvasPath };
  }

  it("creates registration-only metadata and discovers native source without an API apply", async () => {
    const manifest = parseDesignManifest(
      await readFile(path.join(folder, "design.toml"), "utf8"),
    );
    expect(manifest).toMatchObject({ canvas: "canvas.json" });
    expect(manifest?.document).toBeUndefined();
    expect(designDocumentMetadataPath(root, DESIGN_DIRECTORY_NAME)).toBe(
      path.join(folder, "canvas.json"),
    );
    const { html } = await author();
    const frames = await listDesignFrames(root, { writeBack: false });
    expect(frames).toMatchObject([
      { file: "home.html", title: "Home", width: 390, height: 844 },
    ]);
    expect(await readFile(path.join(folder, "home.html"), "utf8")).toBe(html);
    await writeFile(
      path.join(folder, "home.html"),
      html.replace("Hello", "Updated"),
    );
    expect(
      (await readDesignFrame(root, "home.html", 4, { writeBack: false }))
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
    ).toEqual(["home.html"]);
    await updateDesignFrameGeometry(root, "home.html", { x: 500 });
    expect(JSON.parse(await readFile(canvasPath, "utf8")).frames.home.x).toBe(
      500,
    );
  });

  it("renders and selects plain HTML without rewriting it, then visually edits the same source", async () => {
    const { html, canvasPath } = await author();
    const canvasBefore = await readFile(canvasPath, "utf8");
    const snapshot = await readDesignWorkspaceSnapshot(root);
    const frame = await readDesignFrame(root, "home.html");
    expect(await readFile(path.join(folder, "home.html"), "utf8")).toBe(html);
    expect(await readFile(canvasPath, "utf8")).toBe(canvasBefore);
    expect(
      snapshot.lint.violations.some((v) => v.ruleId === "oid-missing"),
    ).toBe(false);
    const heading = frame.tree[0].children[0];
    expect(heading.oid).toBeTruthy();
    const offsets = await readDesignElementOffsetMap(root, "home.html");
    const offset = offsets.find((entry) => entry.oid === heading.oid)!;
    expect(html.slice(offset.startOffset, offset.endOffset)).toBe(
      "<h1>Hello</h1>",
    );
    await setDesignNodeText(root, {
      frame: "home.html",
      nodeId: heading.oid!,
      sourceVersion: frame.sourceVersion,
      text: "Visual edit",
    });
    expect(await readFile(path.join(folder, "home.html"), "utf8")).toContain(
      "Visual edit",
    );
    await writeFile(
      path.join(folder, "home.html"),
      html.replace("Hello", "Native edit"),
    );
    await expect(
      setDesignNodeText(root, {
        frame: "home.html",
        nodeId: heading.oid!,
        sourceVersion: frame.sourceVersion,
        text: "Stale",
      }),
    ).rejects.toThrow(/changed/);
    expect(await readFile(path.join(folder, "home.html"), "utf8")).toContain(
      "Native edit",
    );
  });

  it("preserves identity on native rename and does not erase missing references", async () => {
    const { canvasPath, canvas } = await author();
    await rename(
      path.join(folder, "home.html"),
      path.join(folder, "welcome.html"),
    );
    await expect(listDesignFrames(root, { writeBack: false })).rejects.toThrow(
      /home.html|missing/i,
    );
    expect(
      JSON.parse(await readFile(canvasPath, "utf8")).frames.home,
    ).toBeDefined();
    canvas.frames.home.source = "welcome.html";
    await writeFile(canvasPath, JSON.stringify(canvas));
    expect((await listDesignFrames(root, { writeBack: false }))[0].file).toBe(
      "welcome.html",
    );
  });

  it("assigns a fresh canvas identity when a deleted source filename is reused", async () => {
    const original = await createDesignFrame(root, { title: "Reusable" });
    const first = JSON.parse(
      await readFile(path.join(folder, "canvas.json"), "utf8"),
    );
    await deleteDesignFrame(root, original.file);
    const replacement = await createDesignFrame(root, { title: "Reusable" });
    const second = JSON.parse(
      await readFile(path.join(folder, "canvas.json"), "utf8"),
    );
    expect(replacement.file).toBe(original.file);
    expect(Object.keys(second.frames)).not.toEqual(Object.keys(first.frames));
  });

  it("lets optional inspection and semantic tools use native HTML without a repair pass", async () => {
    const { html } = await author();
    const api = getWorkspaceDesignApi(root);
    const opened = await api.open("frame:home.html");
    const inspected = await api.readProjection({
      documentId: "frame:home.html",
    });
    expect(inspected.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "identity-missing" }),
      ]),
    );
    const heading = inspected.nodes.find((node) => node.tag === "h1")!;
    expect(heading.id).toBe(
      (await readDesignFrame(root, "home.html")).tree[0].children[0].oid,
    );
    await api.readProvenance({
      documentId: "frame:home.html",
      nodeId: heading.id,
      property: "color",
    });
    expect(await readFile(path.join(folder, "home.html"), "utf8")).toBe(html);
    await api.apply({
      schemaVersion: 1,
      actor: { kind: "human", id: "tester" },
      intent: "Edit heading",
      createdAt: 1,
      transactionId: "native-semantic",
      documentId: "frame:home.html",
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
    expect(await readFile(path.join(folder, "home.html"), "utf8")).toContain(
      "Semantic edit",
    );
    await api.undo("frame:home.html");
    expect(await readFile(path.join(folder, "home.html"), "utf8")).toBe(html);
  });

  it("reads an old branch without migrating and explicitly migrates with its identity intact", async () => {
    const { canvasPath } = await author();
    const manifestPath = path.join(folder, "design.toml");
    const id = parseDesignManifest(await readFile(manifestPath, "utf8"))!.id;
    const document = decodeCanvasFile(await readFile(canvasPath, "utf8"));
    const legacy = serializeDesignManifest(id, document);
    await writeFile(manifestPath, legacy);
    await rm(canvasPath);
    expect((await listDesignFrames(root, { writeBack: false }))[0].file).toBe(
      "home.html",
    );
    expect(await readFile(manifestPath, "utf8")).toBe(legacy);
    ensureDesignMetadataLayout(root, DESIGN_DIRECTORY_NAME);
    expect(parseDesignManifest(await readFile(manifestPath, "utf8"))).toEqual({
      id,
      canvas: "canvas.json",
    });
    expect(decodeCanvasFile(await readFile(canvasPath, "utf8"))).toMatchObject(
      document,
    );
  });
});
