import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesignFramesChange } from "@zeros/protocol/messages";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument, prepareDesignNavigationFrames, readDesignNavigationSnapshot } from "../document";
import { designDirectoryNameFor } from "../directory-registry";
import { DesignFrameChanges } from "../frame-changes";
import { resetDesignIdentityCacheForTests } from "../identity-cache";
import { designDirectoryEntry } from "../metadata";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

describe("Design frames a worktree change reaches", () => {
  let root: string;
  let folder: string;
  let published: DesignFramesChange[];
  let changes: DesignFrameChanges;
  const files = ["page-1/a.html", "page-1/b.html", "page-1/c.html"];
  const frame = (body: string) =>
    `<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="m" class="hero card">${body}</main></body></html>`;
  const touch = async (relative: string, content: string | Buffer) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return file;
  };
  const changed = async (...relative: string[]) => {
    published = [];
    for (const file of relative) changes.note(root, path.join(root, file));
    await changes.flush(root);
    return published;
  };
  const editCanvas = async (edit: (canvas: Record<string, any>) => void) => {
    const file = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(file, "utf8"));
    edit(canvas);
    await writeFile(file, JSON.stringify(canvas, null, 2));
  };

  beforeEach(async () => {
    resetDesignIdentityCacheForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-frame-changes-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    folder = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
    await touch(`${DESIGN_DIRECTORY_NAME}/tokens.css`, ".hero { color: red; }");
    await touch(`${DESIGN_DIRECTORY_NAME}/components/card.html`, "<!doctype html><html><head><style>.c { margin: 1px; }</style></head><body><article class=\"c\"><slot></slot></article></body></html>");
    await touch("styles/app.css", ".card { padding: 1px; }");
    await touch("src/app.ts", "export const app = 1;\n");
    await touch(`${DESIGN_DIRECTORY_NAME}/page-1/a.html`, frame('<zd-card data-oid="c">x</zd-card>'));
    await touch(`${DESIGN_DIRECTORY_NAME}/page-1/b.html`, frame("b"));
    await touch(`${DESIGN_DIRECTORY_NAME}/page-1/c.html`, frame('<img data-oid="i" src="../assets/later.png">'));
    await editCanvas((canvas) => {
      canvas.styles = [{ id: "app", title: "App", kind: "css", path: "styles/app.css" }];
      for (const [index, file] of files.entries()) {
        canvas.frames[`frame_${index}`] = { kind: "html", source: file, title: file, x: index * 400, y: 0, width: 320, height: 200 };
        canvas.pages[0].frames.push(`frame_${index}`);
      }
    });
    const navigation = await readDesignNavigationSnapshot(root);
    expect((await prepareDesignNavigationFrames(root, navigation.catalogRevision, files)).errors).toEqual([]);
    const name = designDirectoryNameFor(root);
    const id = designDirectoryEntry(root, name)!.id;
    published = [];
    changes = new DesignFrameChanges({ directory: () => ({ name, id }), publish: (_root, change) => published.push(change) }, 60_000);
  });
  afterEach(async () => {
    changes.stop();
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("names the frames whose reads a change reaches, inside the directory or out, and nothing for other files", async () => {
    await touch(`${DESIGN_DIRECTORY_NAME}/components/card.html`, "<!doctype html><html><body><article><slot></slot></article></body></html>");
    expect(await changed(`${DESIGN_DIRECTORY_NAME}/components/card.html`)).toMatchObject([{ frames: ["page-1/a.html"], catalog: false, all: false }]);
    expect(await changed(`${DESIGN_DIRECTORY_NAME}/tokens.css`)).toMatchObject([{ frames: files, catalog: false, all: false }]);
    expect(await changed("styles/app.css")).toMatchObject([{ frames: files }]);
    expect(await changed(`${DESIGN_DIRECTORY_NAME}/page-1/b.html`)).toMatchObject([{ frames: ["page-1/b.html"] }]);
    // A file a frame looked for and did not find counts once it appears.
    await touch(`${DESIGN_DIRECTORY_NAME}/assets/later.png`, PNG);
    expect(await changed(`${DESIGN_DIRECTORY_NAME}/assets/later.png`)).toMatchObject([{ frames: ["page-1/c.html"] }]);
    expect(await changed("src/app.ts", "README.md")).toEqual([]);
    const sequences = published.map((change) => change.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("re-reads the catalog for canvas edits, naming the frames whose identity inputs moved", async () => {
    await editCanvas((canvas) => { canvas.frames.frame_0.x += 50; });
    expect(await changed(`${DESIGN_DIRECTORY_NAME}/meta/canvas.json`)).toMatchObject([{ frames: [], catalog: true, all: false }]);
    await editCanvas((canvas) => { canvas.frames.frame_1.width = 360; });
    expect(await changed(`${DESIGN_DIRECTORY_NAME}/meta/canvas.json`)).toMatchObject([{ frames: ["page-1/b.html"], catalog: true }]);
    await editCanvas((canvas) => { canvas.styles = []; });
    expect(await changed(`${DESIGN_DIRECTORY_NAME}/meta/canvas.json`)).toMatchObject([{ frames: files, catalog: true }]);
    expect(await changed(".zeros/design-dir.toml")).toMatchObject([{ catalog: true, all: true }]);
  });

  it("finds after an agent's turn what no watcher reported", async () => {
    await touch("styles/app.css", ".card { padding: 9px; }");
    published = [];
    await changes.verifyAll();
    expect(published).toMatchObject([{ frames: files, catalog: false, all: false }]);
    // Nothing else moved, so a second check is silent once those frames are prepared again.
    const navigation = await readDesignNavigationSnapshot(root);
    await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
    published = [];
    await changes.verifyAll();
    expect(published).toEqual([]);
  });
});
