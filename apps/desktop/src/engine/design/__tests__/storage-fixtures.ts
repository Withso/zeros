import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "smol-toml";
import { parseDesignManifest } from "../manifest";
import { decodeCanvasFile, encodeCanvasFile } from "../canvas-file";
import { writeFile } from "node:fs/promises";
import { parse } from "parse5";
import { nextFrameGeometry, readFrameMeta } from "../document-storage";
import type { CanvasDocument } from "../document-model";

export function readCanvasFixture(root: string, directory: string) {
  const manifest = parseDesignManifest(readFileSync(path.join(root, directory, "design.toml"), "utf8"))!;
  return manifest.canvas
    ? decodeCanvasFile(readFileSync(path.join(root, directory, manifest.canvas), "utf8"))
    : manifest.document!;
}

/** Parser/security fixtures used to rely on implicit HTML discovery. Register
 * their source explicitly in the current format, without invoking a read that
 * heals or rewrites the source under test. Existing entries stay untouched. */
export const writeDesignFixtureFile: typeof writeFile = async (file, data, options) => {
  await writeFile(file, data, options);
  if (typeof file !== "string" || !file.endsWith(".html")) return;
  const directory = path.dirname(file);
  let manifest;
  try { manifest = parseDesignManifest(readFileSync(path.join(directory, "design.toml"), "utf8")); }
  catch { return; }
  if (!manifest?.canvas) return;
  const target = path.join(directory, manifest.canvas);
  const canvas = decodeCanvasFile(readFileSync(target, "utf8")) as unknown as CanvasDocument;
  const name = path.basename(file);
  if (canvas.frames[name]) return;
  const meta = readFrameMeta(parse(readFileSync(file, "utf8"), { sourceCodeLocationInfo: true }), name, canvas);
  canvas.frames[name] = nextFrameGeometry(Object.values(canvas.frames), meta);
  canvas.frame_info[name] = { title: meta.title, kind: meta.kind };
  writeFileSync(target, encodeCanvasFile({ ...canvas }));
};

/** Convert an engine-created temporary fixture into an older checkout. */
export function useLegacyDesignStorage(
  root: string,
  directory: string,
  registryFile: string,
  documentFile = "document.json",
) {
  const file = path.join(root, directory, "design.toml");
  const manifest = parseDesignManifest(readFileSync(file, "utf8"))!;
  const document = readCanvasFixture(root, directory);
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
  if (manifest.canvas) rmSync(path.join(root, directory, manifest.canvas));
  return { id: manifest.id, metadata, document };
}
export function parseCanvasFixture(source: string) {
  if (source.trimStart().startsWith("{")) return decodeCanvasFile(source);
  return JSON.parse(JSON.stringify(parseDesignManifest(source)!.document));
}
