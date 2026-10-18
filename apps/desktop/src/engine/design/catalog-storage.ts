import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { DesignCatalogError, projectDesignCatalog } from "./catalog";
import { readCanvasContext } from "./document-storage";
import { canvasReadSnapshot } from "./document-model";
import {
  assertLegacyDesignDraftWritable,
  readDirectoryDesignLayout,
} from "./metadata";
import {
  designPrivateStorageDirectory,
  readDesignStorageFile,
} from "./metadata-storage";
import { designPagesMigrationJournalName } from "./pages-migration";
import { createHash } from "node:crypto";

export function inspectDesignCatalog(root: string, directory: string) {
  assertLegacyDesignDraftWritable(root);
  const layout = readDirectoryDesignLayout(root, directory);
  if (!layout?.manifest.canvas)
    throw new DesignCatalogError("unsupported-layout");
  const key = createHash("sha256").update(directory).digest("hex").slice(0, 24);
  const pending = () =>
    [
      path.join(root, directory, ".zeros-transaction.json"),
      ...[
        "directory-rename.json",
        `metadata-${key}.json`,
        designPagesMigrationJournalName(directory),
        `transaction-${layout.manifest.id}.json`,
        `transaction-${key}.json`,
      ].map((name) => path.join(designPrivateStorageDirectory(root), name)),
    ].some((file) => lstatSync(file, { throwIfNoEntry: false }));
  if (pending()) throw new DesignCatalogError("unsettled");
  const roots = [root, path.join(root, directory)].map((folder) => {
    const canonical = realpathSync(folder);
    const stat = lstatSync(canonical);
    if (!stat.isDirectory()) throw new DesignCatalogError("stale");
    return [canonical, stat.dev, stat.ino];
  });
  const registration = readDesignStorageFile(root, layout.manifestFile);
  const source = readDesignStorageFile(root, layout.documentFile);
  if (registration === null || source === null || pending())
    throw new DesignCatalogError("unsettled");
  return {
    layout,
    registration,
    source,
    binding: JSON.stringify(roots),
    revision: createHash("sha256")
      .update(
        JSON.stringify([
          layout.manifestFile,
          registration,
          layout.documentFile,
          source,
        ]),
      )
      .digest("hex"),
  };
}

export async function readDesignCatalogMetadata(
  root: string,
  directory: string,
) {
  const before = inspectDesignCatalog(root, directory);
  const context = await readCanvasContext(root);
  const captured = context.canvas[canvasReadSnapshot];
  const after = inspectDesignCatalog(root, directory);
  if (
    before.binding !== after.binding ||
    before.revision !== after.revision ||
    captured?.source !== before.source ||
    captured.registration?.source !== before.registration
  )
    throw new DesignCatalogError("stale");
  return {
    directoryId: before.layout.manifest.id,
    binding: before.binding,
    revision: before.revision,
    ...projectDesignCatalog(context.canvas),
  };
}
