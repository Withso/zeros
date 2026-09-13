import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "smol-toml";
import { parseDesignManifest } from "../manifest";

/** Convert an engine-created temporary fixture into an older checkout. */
export function useLegacyDesignStorage(
  root: string,
  directory: string,
  registryFile: string,
  documentFile = "document.json",
) {
  const file = path.join(root, directory, "design.toml");
  const manifest = parseDesignManifest(readFileSync(file, "utf8"))!;
  const metadata = `.zeros/design/${manifest.id}/${documentFile}`;
  mkdirSync(path.dirname(path.join(root, metadata)), { recursive: true });
  writeFileSync(path.join(root, metadata), JSON.stringify(manifest.document));
  writeFileSync(
    path.join(root, registryFile),
    stringify({
      version: 1,
      directories: { [manifest.id]: { path: directory } },
    }) + "\n",
  );
  rmSync(file);
  return { id: manifest.id, metadata, document: manifest.document };
}
export function parseCanvasFixture(source: string) {
  return JSON.parse(JSON.stringify(parseDesignManifest(source)!.document));
}
