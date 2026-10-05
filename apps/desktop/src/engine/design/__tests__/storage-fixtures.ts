import { mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "smol-toml";
import { parseDesignManifest } from "../manifest";
import { decodeCanvasFile, encodeCanvasFile } from "../canvas-file";
import { writeFile } from "node:fs/promises";
import { parse } from "parse5";
import { nextFrameGeometry, readFrameMeta } from "../document-storage";
import type { CanvasDocument } from "../document-model";
import { readDirectoryDesignLayout } from "../metadata";
import { legacyFrameId } from "../canvas-file";
import { rebaseDesignHtmlReferences } from "@zeros/design-web";

export function readCanvasFixture(root: string, directory: string) {
  const layout = readDirectoryDesignLayout(root, directory)!;
  const manifest = layout.manifest;
  return manifest.canvas
    ? decodeCanvasFile(readFileSync(path.join(root, layout.documentFile), "utf8"), { version: layout.canvasVersion })
    : manifest.document!;
}

/** Parser/security fixtures used to rely on implicit HTML discovery. Register
 * their source explicitly in the current format, without invoking a read that
 * heals or rewrites the source under test. Existing entries stay untouched. */
export const writeDesignFixtureFile: typeof writeFile = async (file, data, options) => {
  await writeFile(file, data, options);
  if (typeof file !== "string" || !file.endsWith(".html")) return;
  let directory = path.dirname(file);
  let layout;
  for (let depth = 0; depth < 2; depth++, directory = path.dirname(directory)) {
    try { layout = readDirectoryDesignLayout(path.dirname(directory), path.basename(directory)); }
    catch { return; }
    if (layout) break;
  }
  if (!layout?.manifest.canvas) return;
  const target = path.join(path.dirname(directory), layout.documentFile);
  const canvas = decodeCanvasFile(readFileSync(target, "utf8"), { version: layout.canvasVersion }) as unknown as CanvasDocument;
  const name = path.relative(directory, file).split(path.sep).join("/");
  if (layout.canvasVersion === 2 && !canvas.pages?.some(page => page.folder === path.posix.dirname(name))) return;
  if (canvas.frames[name]) return;
  const meta = readFrameMeta(parse(readFileSync(file, "utf8"), { sourceCodeLocationInfo: true }), name, canvas);
  canvas.frames[name] = nextFrameGeometry(Object.values(canvas.frames), meta);
  canvas.frame_info[name] = { id: legacyFrameId(name), title: meta.title, kind: meta.kind };
  if (layout.canvasVersion === 2) {
    const page = canvas.pages?.find(page => page.folder === path.posix.dirname(name));
    if (!page) throw new Error("Register a parser fixture in an existing page folder.");
    page.frames.push(canvas.frame_info[name]!.id!);
  }
  writeFileSync(target, encodeCanvasFile({ ...canvas }, { version: layout.canvasVersion }));
};

/** Convert an engine-created temporary fixture into an older checkout. */
export function useLegacyDesignStorage(
  root: string,
  directory: string,
  registryFile: string,
  documentFile = "document.json",
) {
  const layout = readDirectoryDesignLayout(root, directory)!;
  const file = path.join(root, layout.manifestFile);
  const manifest = layout.manifest;
  let document = readCanvasFixture(root, directory);
  if (layout.canvasVersion === 2) {
    const pages = document.pages as Array<{ folder?: string; [key: string]: unknown }>;
    if (pages.length !== 1) throw new Error("A legacy fixture requires exactly one page.");
    const movedFiles = Object.fromEntries(Object.keys(document.frames as object).map(source => [source, path.posix.basename(source)]));
    for (const [source, target] of Object.entries(movedFiles)) {
      writeFileSync(path.join(root, directory, target), rebaseDesignHtmlReferences(readFileSync(path.join(root, directory, source), "utf8"), source, target, { movedFiles }));
      rmSync(path.join(root, directory, source));
    }
    for (const page of pages)
      if (page.folder && readdirSync(path.join(root, directory, page.folder)).length === 0)
        rmdirSync(path.join(root, directory, page.folder));
    document = {
      ...document,
      pages: pages.map(({ folder: _folder, ...page }) => page),
      frames: Object.fromEntries(Object.entries(document.frames as object).map(([source, geometry]) => [movedFiles[source], geometry])),
      frame_info: Object.fromEntries(Object.entries(document.frame_info as object).map(([source, info]) => [movedFiles[source], info])),
    };
  }
  const metadata = `.zeros/design/${manifest.id}/${documentFile}`;
  mkdirSync(path.dirname(path.join(root, metadata)), { recursive: true });
  writeFileSync(path.join(root, metadata), JSON.stringify(document));
  writeFileSync(
    path.join(root, registryFile),
    stringify({
      version: 1,
      directories: { [manifest.id]: { path: directory } },
    }) + "\n",
  );
  rmSync(file);
  if (manifest.canvas) rmSync(path.join(root, layout.documentFile));
  if (layout.canvasVersion === 2 && readdirSync(path.join(root, directory, "meta")).length === 0)
    rmdirSync(path.join(root, directory, "meta"));
  return { id: manifest.id, metadata, document };
}
export function parseCanvasFixture(source: string) {
  if (source.trimStart().startsWith("{")) return decodeCanvasFile(source);
  return JSON.parse(JSON.stringify(parseDesignManifest(source)!.document));
}
