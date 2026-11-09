// Fonts out of the recorder's pictures (externalized typefaces, see
// apps/desktop/shared/design-picture-typefaces.ts): the picture
// printToSkPicture wrote is rewritten to reference each font by content id,
// and each font's data is written once per recorder session.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { designTypefaceContentId, externalizeDesignPictureTypefaces } from "../shared/design-picture-typefaces";

export interface RecordedLayerTypefaces {
  /** Fonts the rewritten picture references, by content id, in first use. */
  readonly typefaces: Array<{ id: string; path: string }>;
  /** Why the picture was left as written, embedding its fonts. */
  readonly skipped?: string;
}

/** Content ids of the fonts this session has hashed. Chromium writes a font's
 * bytes identically into every picture that uses it, so a font seen again is
 * matched by comparing every byte with the copy kept here, and only a font
 * not seen before is hashed. An id is always exactly
 * `designTypefaceContentId(bytes)`: every reader verifies fonts against it. */
export class RecordedTypefaceIds {
  readonly #known = new Map<number, Array<{ bytes: Buffer; id: string }>>();
  readonly #budgetBytes: number;
  readonly #hash: (bytes: Uint8Array) => Promise<string>;
  #heldBytes = 0;

  constructor(options: { budgetBytes?: number; hash?: (bytes: Uint8Array) => Promise<string> } = {}) {
    this.#budgetBytes = options.budgetBytes ?? 128 * 1024 * 1024;
    this.#hash = options.hash ?? designTypefaceContentId;
  }

  async contentId(bytes: Uint8Array): Promise<string> {
    const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const entry of this.#known.get(view.length) ?? []) if (entry.bytes.equals(view)) return entry.id;
    const id = await this.#hash(bytes);
    const known = this.#known.get(view.length) ?? [];
    if (this.#heldBytes + view.length <= this.#budgetBytes && !known.some((entry) => entry.id === id)) {
      // A copy: the picture's buffer is released after this layer.
      known.push({ bytes: Buffer.from(view), id });
      this.#known.set(view.length, known);
      this.#heldBytes += view.length;
    }
    return id;
  }
}

/** Rewrites `layer` in place. `written` remembers the ids whose data already
 * sits in `folder` this session, so each font file is written once. */
export async function externalizeRecordedLayer(layer: string, folder: string, written: Set<string>,
  ids?: RecordedTypefaceIds): Promise<RecordedLayerTypefaces> {
  const original = new Uint8Array(await readFile(layer));
  const result = await externalizeDesignPictureTypefaces(original, ids ? { contentId: (bytes) => ids.contentId(bytes) } : {});
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
