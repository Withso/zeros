import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { designPictureTypefaceReferences, internalizeDesignPictureTypefaces } from "../../shared/design-picture-typefaces";
import { externalizeRecordedLayer, RecordedTypefaceIds } from "../design-recorder-typefaces";

/** A minimal picture in the canvaskit/0.42.0 layout: one typeface record
 * embedding `font`, then the end tag. */
function picture(font: Uint8Array): Uint8Array {
  const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; };
  const tag = (text: string) => u32((text.charCodeAt(0) << 24 | text.charCodeAt(1) << 16 | text.charCodeAt(2) << 8 | text.charCodeAt(3)) >>> 0);
  const packed = (value: number) => value <= 0xfd ? Buffer.of(value) : value <= 0xffff ? Buffer.of(0xfe, value & 0xff, value >> 8)
    : Buffer.of(0xff, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const info = Buffer.concat([Buffer.from("skiapict"), u32(100), Buffer.alloc(16)]);
  const record = Buffer.concat([packed(0), packed(0x01), packed(5), Buffer.from("Geist"), packed(0xff), packed(font.length), Buffer.from(font)]);
  return Buffer.concat([info, Buffer.of(1), tag("tpfc"), u32(1), record, tag("eof ")]);
}
const idOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").slice(0, 32);

describe("recorder typefaces", () => {
  let folder: string;
  beforeEach(async () => { folder = await mkdtemp(path.join(tmpdir(), "zeros-design-recorder-typefaces-")); });
  afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

  it("rewrites a recorded picture to reference its fonts and writes each font once per session", async () => {
    const font = randomBytes(70_000);
    const first = path.join(folder, "a.skp"), second = path.join(folder, "b.skp");
    await writeFile(first, picture(font));
    await writeFile(second, picture(font));
    const written = new Set<string>();
    const a = await externalizeRecordedLayer(first, folder, written);
    expect(a).toEqual({ typefaces: [{ id: idOf(font), path: path.join(folder, `${idOf(font)}.font`) }] });
    const fontFile = await stat(a.typefaces[0]!.path);
    const b = await externalizeRecordedLayer(second, folder, written);
    expect(b.typefaces).toEqual(a.typefaces);
    expect((await stat(a.typefaces[0]!.path)).mtimeMs).toBe(fontFile.mtimeMs);
    const rewritten = new Uint8Array(await readFile(first));
    expect(rewritten.length).toBeLessThan(1_000);
    expect(designPictureTypefaceReferences(rewritten)).toEqual([idOf(font)]);
    const fontBytes = new Uint8Array(await readFile(a.typefaces[0]!.path));
    expect(Buffer.from(internalizeDesignPictureTypefaces(rewritten, (id) => (id === idOf(font) ? fontBytes : null))!)).toEqual(Buffer.from(picture(font)));
  });

  it("hashes a font once a session, reusing its id only for identical bytes", async () => {
    let hashed = 0;
    const ids = new RecordedTypefaceIds({ budgetBytes: 150_000, hash: async (bytes) => { hashed++; return idOf(bytes); } });
    const font = randomBytes(70_000), sameLength = randomBytes(70_000), large = randomBytes(90_000);
    expect(await ids.contentId(font)).toBe(idOf(font));
    // The same bytes in another picture's buffer, at an offset.
    const elsewhere = Buffer.concat([Buffer.alloc(13), font]).subarray(13);
    expect(await ids.contentId(elsewhere)).toBe(idOf(font));
    expect(hashed).toBe(1);
    expect(await ids.contentId(sameLength)).toBe(idOf(sameLength));
    expect(hashed).toBe(2);
    // Past the budget a font is still hashed correctly, just not kept.
    expect(await ids.contentId(large)).toBe(idOf(large));
    expect(await ids.contentId(large)).toBe(idOf(large));
    expect(hashed).toBe(4);
    const file = path.join(folder, "d.skp");
    await writeFile(file, picture(font));
    const result = await externalizeRecordedLayer(file, folder, new Set(), ids);
    expect(result.typefaces.map((typeface) => typeface.id)).toEqual([idOf(font)]);
    expect(hashed).toBe(4);
    expect(designPictureTypefaceReferences(new Uint8Array(await readFile(file)))).toEqual([idOf(font)]);
  });

  it("leaves a picture it does not understand as written", async () => {
    const file = path.join(folder, "c.skp");
    await writeFile(file, "not a picture");
    const result = await externalizeRecordedLayer(file, folder, new Set());
    expect(result.typefaces).toEqual([]);
    expect(result.skipped).toBeTruthy();
    expect(await readFile(file, "utf8")).toBe("not a picture");
  });
});
