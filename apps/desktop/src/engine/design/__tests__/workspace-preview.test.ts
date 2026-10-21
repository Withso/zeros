import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DesignHeadlessRenderer } from "@zeros/design-web";
import { createDesignFrame, initializeDesignDocument, readDesignFrameRenderIdentity } from "../document";
import { designDirectoryNameFor, forgetDesignDirectoryName } from "../directory-registry";
import { designDirectoryEntry } from "../metadata";
import { previewWorkspaceDesign } from "../workspace-capture";

let root: string;
let frame: string;
let renders: Parameters<DesignHeadlessRenderer["render"]>[0][];
let renderer: DesignHeadlessRenderer;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-design-preview-"));
  await initializeDesignDocument(root);
  frame = (await createDesignFrame(root, { title: "Preview" })).file;
  const directory = designDirectoryNameFor(root);
  const canvasPath = path.join(root, directory, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
  const id = Object.keys(canvas.frames).find((key) => canvas.frames[key].source === frame)!;
  canvas.frames[id] = { ...canvas.frames[id], width: 1600, height: 1000 };
  canvas.themes = [{ id: "dark", label: "Dark", base: true }, { id: "light", label: "Light" }];
  await writeFile(canvasPath, JSON.stringify(canvas));
  renders = [];
  renderer = {
    async render(input) {
      renders.push(input);
      const size = input.rasterSize ?? input.viewport;
      const identity = await readDesignFrameRenderIdentity(root, frame);
      return {
        mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]), width: size.width, height: size.height,
        revision: input.state.revision, metadata: { sourceVersion: identity.sourceVersion },
      };
    },
  };
});

afterEach(async () => {
  forgetDesignDirectoryName(root);
  await rm(root, { recursive: true, force: true });
});

it("captures a frame at its canvas size into a preview-sized raster in the requested theme", async () => {
  const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
  const preview = await previewWorkspaceDesign(
    root,
    { workspaceId: "workspace-1", frame, sourceVersion, theme: "light", maxDimension: 384 },
    { renderer },
  );
  expect(renders).toHaveLength(1);
  expect(renders[0]).toMatchObject({
    viewport: { width: 1600, height: 1000, reducedMotion: "reduce" },
    rasterSize: { width: 384, height: 240 },
    theme: "light",
  });
  expect(preview).toEqual({
    sourceVersion, theme: "light", mimeType: "image/png", width: 384, height: 240,
    data: Buffer.from([137, 80, 78, 71]).toString("base64"),
  });
});

it("lays a frame taller than 8192 px out whole, so its picture is neither cut nor stretched", async () => {
  const directory = designDirectoryNameFor(root);
  const canvasPath = path.join(root, directory, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
  const id = Object.keys(canvas.frames).find((key) => canvas.frames[key].source === frame)!;
  canvas.frames[id] = { ...canvas.frames[id], width: 1440, height: 12000 };
  await writeFile(canvasPath, JSON.stringify(canvas));
  const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
  const preview = await previewWorkspaceDesign(
    root,
    { workspaceId: "workspace-1", frame, sourceVersion, theme: null, maxDimension: 384 },
    { renderer },
  );
  expect(renders[0]).toMatchObject({ viewport: { width: 1440, height: 12000 }, rasterSize: { width: 46, height: 384 } });
  expect(preview).toMatchObject({ sourceVersion, width: 46, height: 384 });
});

it("reports a stale request without rendering, so the canvas re-asks with the saved version", async () => {
  const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
  const preview = await previewWorkspaceDesign(
    root,
    { workspaceId: "workspace-1", frame, sourceVersion: "0".repeat(24), theme: null, maxDimension: 384 },
    { renderer },
  );
  expect(preview).toEqual({ stale: true, sourceVersion });
  expect(renders).toHaveLength(0);
});

it("previews a fractional canvas size at whole layout pixels without reporting it stale", async () => {
  const directory = designDirectoryNameFor(root);
  const canvasPath = path.join(root, directory, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
  const id = Object.keys(canvas.frames).find((key) => canvas.frames[key].source === frame)!;
  canvas.frames[id] = { ...canvas.frames[id], width: 1600.5, height: 1000.25 };
  await writeFile(canvasPath, JSON.stringify(canvas));
  const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
  // The fake reports its own generation, as a real host does for the
  // whole-pixel viewport it laid out; only the saved source decides staleness.
  renderer.render = async (input) => {
    renders.push(input);
    const size = input.rasterSize ?? input.viewport;
    return { mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]), width: size.width,
      height: size.height, revision: input.state.revision, metadata: { sourceVersion: "f".repeat(24) } };
  };
  const preview = await previewWorkspaceDesign(
    root,
    { workspaceId: "workspace-1", frame, sourceVersion, theme: null, maxDimension: 384 },
    { renderer },
  );
  expect(renders[0]).toMatchObject({ viewport: { width: 1601, height: 1001 } });
  expect(preview).toMatchObject({ sourceVersion, theme: null, width: 384, height: 240 });
});

it("reports stale with the generation it rendered when the frame changed before the render read it", async () => {
  const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
  const directory = designDirectoryNameFor(root);
  const inner = renderer.render.bind(renderer);
  renderer.render = async (input) => {
    await writeFile(path.join(root, directory, frame), "<main data-oid=\"changed\">Changed</main>");
    return inner(input);
  };
  const preview = await previewWorkspaceDesign(
    root,
    { workspaceId: "workspace-1", frame, sourceVersion, theme: null, maxDimension: 384 },
    { renderer },
  );
  const current = await readDesignFrameRenderIdentity(root, frame);
  expect(current.sourceVersion).not.toBe(sourceVersion);
  expect(preview).toEqual({ stale: true, sourceVersion: current.sourceVersion });
});

it("keeps a whole-pixel picture of the asked generation when the frame changes after the render read it", async () => {
  // The artifact names the generation it rendered, so the picture is true to
  // the version the canvas asked for; the canvas asks again for the new one.
  const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
  const directory = designDirectoryNameFor(root);
  const inner = renderer.render.bind(renderer);
  renderer.render = async (input) => {
    const artifact = await inner(input);
    await writeFile(path.join(root, directory, frame), "<main data-oid=\"changed\">Changed</main>");
    return artifact;
  };
  const preview = await previewWorkspaceDesign(
    root,
    { workspaceId: "workspace-1", frame, sourceVersion, theme: null, maxDimension: 384 },
    { renderer },
  );
  expect(preview).toMatchObject({ sourceVersion, width: 384, height: 240 });
});

it("reads a fractional frame again after rendering and reports a change made meanwhile", async () => {
  const directory = designDirectoryNameFor(root);
  const canvasPath = path.join(root, directory, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(canvasPath, "utf8"));
  const id = Object.keys(canvas.frames).find((key) => canvas.frames[key].source === frame)!;
  canvas.frames[id] = { ...canvas.frames[id], width: 1600.5, height: 1000.25 };
  await writeFile(canvasPath, JSON.stringify(canvas));
  const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
  const inner = renderer.render.bind(renderer);
  renderer.render = async (input) => {
    const artifact = await inner(input);
    await writeFile(path.join(root, directory, frame), "<main data-oid=\"changed\">Changed</main>");
    return artifact;
  };
  const preview = await previewWorkspaceDesign(
    root,
    { workspaceId: "workspace-1", frame, sourceVersion, theme: null, maxDimension: 384 },
    { renderer },
  );
  const current = await readDesignFrameRenderIdentity(root, frame);
  expect(current.sourceVersion).not.toBe(sourceVersion);
  expect(preview).toEqual({ stale: true, sourceVersion: current.sourceVersion });
});

it("refuses a directory the workspace no longer shows, so its preview is never cached under another", async () => {
  const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
  const directoryId = designDirectoryEntry(root, designDirectoryNameFor(root))!.id;
  const request = { workspaceId: "workspace-1", frame, sourceVersion, theme: null, maxDimension: 384 };
  await expect(previewWorkspaceDesign(root, { ...request, directoryId: "design_other" }, { renderer }))
    .rejects.toThrow("The active Design directory changed. Refresh before previewing.");
  expect(renders).toHaveLength(0);
  await expect(previewWorkspaceDesign(root, { ...request, directoryId }, { renderer }))
    .resolves.toMatchObject({ sourceVersion, width: 384, height: 240 });
});

it("refuses a theme the directory does not offer and an out-of-range size", async () => {
  const { sourceVersion } = await readDesignFrameRenderIdentity(root, frame);
  await expect(
    previewWorkspaceDesign(root, { workspaceId: "workspace-1", frame, sourceVersion, theme: "sepia", maxDimension: 384 }, { renderer }),
  ).rejects.toThrow('Unknown theme "sepia". Choose one of: dark, light.');
  await expect(
    previewWorkspaceDesign(root, { workspaceId: "workspace-1", frame, sourceVersion, theme: null, maxDimension: 4096 }, { renderer }),
  ).rejects.toThrow();
  expect(renders).toHaveLength(0);
});
