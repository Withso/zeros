// Fonts out of the recorder's pictures (externalized typefaces, see
// apps/desktop/shared/design-picture-typefaces.ts): the picture
// printToSkPicture wrote is rewritten to reference each font by content id,
// and each font's data is written once per recorder session.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { externalizeDesignPictureTypefaces } from "../shared/design-picture-typefaces";

export interface RecordedLayerTypefaces {
  /** Fonts the rewritten picture references, by content id, in first use. */
  readonly typefaces: Array<{ id: string; path: string }>;
  /** Why the picture was left as written, embedding its fonts. */
  readonly skipped?: string;
}

/** Rewrites `layer` in place. `written` remembers the ids whose data already
 * sits in `folder` this session, so each font file is written once. */
export async function externalizeRecordedLayer(layer: string, folder: string, written: Set<string>): Promise<RecordedLayerTypefaces> {
  const original = new Uint8Array(await readFile(layer));
  const result = await externalizeDesignPictureTypefaces(original);
  if (result.skipped !== undefined || result.typefaces.length === 0)
    return { typefaces: [], ...(result.skipped !== undefined ? { skipped: result.skipped } : {}) };
  const typefaces: Array<{ id: string; path: string }> = [];
  for (const typeface of result.typefaces) {
    const file = path.join(folder, `${typeface.id}.font`);
    if (!written.has(typeface.id)) {
      await writeFile(file, typeface.bytes, { mode: 0o600 });
      written.add(typeface.id);
    }
    typefaces.push({ id: typeface.id, path: file });
  }
  // Fonts first: a picture that references a font is never left without it.
  await writeFile(layer, result.skp, { mode: 0o600 });
  return { typefaces };
}
