import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as documents from "../document";
import { createDesignFrame, initializeDesignDocument } from "../document";
import { createDesignContextReference, inspectDesignContext } from "../context";
import { designDirectoryNameFor, forgetDesignDirectoryName } from "../directory-registry";

describe("Design frame context ownership", () => {
  let root: string;
  let frame: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-context-"));
    await initializeDesignDocument(root);
    frame = (await createDesignFrame(root, { title: "Selected screen" })).file;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    forgetDesignDirectoryName(root);
    await rm(root, { recursive: true, force: true });
  });

  it("binds the stable frame identity, source directory and viewport without writing source", async () => {
    const source = path.join(root, designDirectoryNameFor(root), frame);
    const before = await readFile(source, "utf8");
    const reference = await createDesignContextReference(root, "workspace", frame);
    expect(reference.frameId).toMatch(/^frame_/);
    const inspected = await inspectDesignContext(root, reference);
    expect(inspected).toMatchObject({
      status: "ready", directory: designDirectoryNameFor(root), title: "Selected screen",
      width: expect.any(Number), height: expect.any(Number), reference,
    });
    expect(await readFile(source, "utf8")).toBe(before);
  });

  it("rejects a directory switch before reference creation instead of retargeting the same filename", async () => {
    await expect(createDesignContextReference(root, "workspace", frame, undefined, "design_replaced"))
      .rejects.toThrow(/directory.*changed/i);
  });

  it("reports source edits as stale and keeps the submitted reference unchanged", async () => {
    const reference = await createDesignContextReference(root, "workspace", frame);
    const original = { ...reference };
    const source = path.join(root, designDirectoryNameFor(root), frame);
    await writeFile(source, (await readFile(source, "utf8")).replace("Selected screen", "Updated screen"));
    expect(await inspectDesignContext(root, reference)).toMatchObject({ status: "stale", reference });
    expect(reference).toEqual(original);
  });

  it("rejects a same-name frame replacement after the final source read", async () => {
    const reference = await createDesignContextReference(root, "workspace", frame);
    const read = documents.readDesignFrame;
    vi.spyOn(documents, "readDesignFrame").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      const filename = path.join(root, designDirectoryNameFor(root), "meta/canvas.json");
      const canvas = JSON.parse(await readFile(filename, "utf8"));
      const id = Object.keys(canvas.frames)[0]!;
      canvas.frames.frame_replacement = canvas.frames[id];
      delete canvas.frames[id];
      for (const page of canvas.pages) page.frames = page.frames.map((key: string) => key === id ? "frame_replacement" : key);
      await writeFile(filename, JSON.stringify(canvas));
      return result;
    });
    expect(await inspectDesignContext(root, reference)).toEqual({ status: "missing", reference });
  });

  it("rejects a directory replacement while creating a reference", async () => {
    const identity = documents.readDesignFrameSelectionIdentity;
    vi.spyOn(documents, "readDesignFrameSelectionIdentity").mockImplementationOnce(async (...args) => {
      const result = await identity(...args);
      const filename = path.join(root, designDirectoryNameFor(root), "meta/design.toml");
      const manifest = await readFile(filename, "utf8");
      await writeFile(filename, manifest.replace(/^id = .*$/m, 'id = "design_replacement"'));
      return result;
    });
    await expect(createDesignContextReference(root, "workspace", frame)).rejects.toThrow(/changed while reading/);
  });
});
