import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDesignFrame,
  DESIGN_DIRECTORY_NAME,
  initializeDesignDocument,
  lintDesignDocument,
  readDesignFrame,
  updateDesignNodeStyles,
} from "../document";
import { healDesignOids } from "../node-identities";

// data-zd-captured marks markup that came from elsewhere. Nothing in the edit
// paths gives the attribute meaning, so it must survive them unchanged.
describe("the captured-markup marker in saved source", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-captured-"));
    await initializeDesignDocument(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("survives oid healing", () => {
    const healed = healDesignOids('<!doctype html><html><head></head><body data-zd-captured="zeros renderer"><main><p>Hi</p></main></body></html>');
    expect(healed.changed).toBe(true);
    expect(healed.html).toContain('<body data-zd-captured="zeros renderer">');
  });

  it("survives a Style panel edit of the captured element and of one inside it", async () => {
    const created = await createDesignFrame(root, { title: "Captured" });
    const file = path.join(root, DESIGN_DIRECTORY_NAME, created.file);
    await writeFile(file, '<!doctype html><html><head></head><body><section data-oid="shot" data-zd-captured="zeros renderer" class="shot"><p data-oid="copy">Hi</p></section></body></html>');
    // Reading publishes the frame's render generation the edit is checked against.
    await lintDesignDocument(root, created.file);
    for (const nodeId of ["shot", "copy"]) {
      const before = await readDesignFrame(root, created.file);
      const mutation = await updateDesignNodeStyles(root, {
        frame: created.file,
        nodeId,
        sourceVersion: before.sourceVersion,
        styles: { padding: "8px" },
      });
      expect(mutation.changed).toBe(true);
    }
    const saved = await readFile(file, "utf8");
    expect(saved).toContain('data-zd-captured="zeros renderer"');
    expect(saved).toContain('data-oid="shot" data-zd-captured="zeros renderer" class="shot" style="padding:8px;"');
    expect(saved).toContain('<p data-oid="copy" style="padding:8px;">');
  });
});
