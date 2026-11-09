// Externalized typefaces in recorded Skia pictures.
//
// A picture serialized with kDoIncludeData carries the whole font file of
// every typeface it draws with (a system fallback font is about 8 MB). Every
// recording of a page repeats the same few fonts. Externalizing replaces each
// embedded font file with a 37-byte reference to its content id, so a font
// is stored, sent and parsed once; a matching CanvasKit build resolves the
// reference from a registry of verified font bytes.
//
// Layout (Skia canvaskit/0.42.0, src/core/SkPicture.cpp, SkPictureData.cpp,
// SkFontDescriptor.cpp): a 28-byte SkPictInfo, one trailing byte, then
// `u32 tag, u32 size` sections until `eof `. `tpfc` holds `size` typeface
// records; `pctr` holds `size` nested pictures, each with its own `tpfc`.
// No size or offset refers to typeface bytes (paints refer to typefaces by
// index), so a record's data can change length without touching anything else.

const MAGIC = [0x73, 0x6b, 0x69, 0x61, 0x70, 0x69, 0x63, 0x74]; // "skiapict"
const PICT_INFO_BYTES = 28;
const TRAILING_NONE = 0, TRAILING_DATA = 1, TRAILING_CUSTOM = 2;
// SkSetFourByteTag puts the first character in the high byte; tags are
// written as little-endian u32.
const tag = (text: string) => (text.charCodeAt(0) << 24 | text.charCodeAt(1) << 16 | text.charCodeAt(2) << 8 | text.charCodeAt(3)) >>> 0;
const TAG = { read: tag("read"), fact: tag("fact"), tpfc: tag("tpfc"), pctr: tag("pctr"), aray: tag("aray"), eof: tag("eof ") };

/** `ZRTF`, format 1, then 32 ASCII hex characters of the content id. */
export const DESIGN_TYPEFACE_REFERENCE_MAGIC = Object.freeze([0x5a, 0x52, 0x54, 0x46, 0x01]);
export const DESIGN_TYPEFACE_REFERENCE_BYTES = DESIGN_TYPEFACE_REFERENCE_MAGIC.length + 32;
const ID_PATTERN = /^[a-f0-9]{32}$/;

export interface DesignPictureTypefaceRecord {
  /** Byte offset of the record (its style bits) in the picture. */
  readonly start: number;
  /** Offset of the font data's packed length. */
  readonly dataLengthAt: number;
  readonly dataStart: number;
  readonly dataLength: number;
  readonly end: number;
  readonly familyName: string | null;
  /** Content id when the data is already a reference. */
  readonly reference: string | null;
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array, private readonly view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)) {}
  need(length: number) {
    if (length < 0 || this.offset + length > this.bytes.length) throw new Error("Truncated picture.");
  }
  u8() { this.need(1); return this.bytes[this.offset++]!; }
  u16() { this.need(2); const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  u32() { this.need(4); const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
  i32() { this.need(4); const value = this.view.getInt32(this.offset, true); this.offset += 4; return value; }
  skip(length: number) { this.need(length); this.offset += length; }
  packed() {
    const first = this.u8();
    return first === 0xfe ? this.u16() : first === 0xff ? this.u32() : first;
  }
}

function readTypeface(reader: Reader): DesignPictureTypefaceRecord {
  const start = reader.offset;
  let familyName: string | null = null;
  reader.packed(); // style bits
  for (;;) {
    const id = reader.packed();
    if (id === 0xff) break;
    switch (id) {
      case 0x01: case 0x04: case 0x06: {
        const length = reader.packed();
        reader.need(length);
        if (id === 0x01) familyName = new TextDecoder().decode(reader.bytes.subarray(reader.offset, reader.offset + length));
        reader.skip(length);
        break;
      }
      case 0x10: case 0x11: case 0x12: case 0x13: reader.skip(4); break;
      case 0xfa: { const count = reader.packed(); reader.skip(count * 8); break; }
      case 0xf9: { const count = reader.packed(); for (let index = 0; index < count; index++) { reader.packed(); reader.skip(4); } break; }
      case 0xf8: case 0xfc: case 0xfd: reader.packed(); break;
      case 0xf6: case 0xf7: break;
      default: throw new Error(`Unknown typeface descriptor field ${id}.`);
    }
  }
  const dataLengthAt = reader.offset;
  const dataLength = reader.packed();
  const dataStart = reader.offset;
  reader.skip(dataLength);
  let reference: string | null = null;
  if (dataLength === DESIGN_TYPEFACE_REFERENCE_BYTES &&
    DESIGN_TYPEFACE_REFERENCE_MAGIC.every((byte, index) => reader.bytes[dataStart + index] === byte)) {
    const id = new TextDecoder().decode(reader.bytes.subarray(dataStart + DESIGN_TYPEFACE_REFERENCE_MAGIC.length, dataStart + dataLength));
    if (ID_PATTERN.test(id)) reference = id;
  }
  return { start, dataLengthAt, dataStart, dataLength, end: reader.offset, familyName, reference };
}

function readPicture(reader: Reader, records: DesignPictureTypefaceRecord[], depth: number): void {
  if (depth > 16) throw new Error("Pictures nest too deeply.");
  reader.need(PICT_INFO_BYTES);
  if (!MAGIC.every((byte, index) => reader.bytes[reader.offset + index] === byte)) throw new Error("Not a Skia picture.");
  reader.skip(PICT_INFO_BYTES);
  const trailing = reader.u8();
  if (trailing === TRAILING_NONE) return;
  if (trailing === TRAILING_CUSTOM) {
    const size = -reader.i32();
    reader.skip(size + (size & 3 ? 4 - (size & 3) : 0));
    return;
  }
  if (trailing !== TRAILING_DATA) throw new Error("Unknown picture payload.");
  for (;;) {
    const section = reader.u32();
    if (section === TAG.eof) return;
    const size = reader.u32();
    if (section === TAG.read || section === TAG.fact || section === TAG.aray) reader.skip(size);
    else if (section === TAG.tpfc) for (let index = 0; index < size; index++) records.push(readTypeface(reader));
    else if (section === TAG.pctr) for (let index = 0; index < size; index++) readPicture(reader, records, depth + 1);
    else throw new Error(`Unknown picture section ${section >>> 0}.`);
  }
}

/** Every typeface record of a picture and its nested pictures, in order. */
export function inspectDesignPictureTypefaces(skp: Uint8Array): DesignPictureTypefaceRecord[] {
  const reader = new Reader(skp);
  const records: DesignPictureTypefaceRecord[] = [];
  readPicture(reader, records, 0);
  if (reader.offset !== skp.length) throw new Error("Trailing bytes after the picture.");
  return records;
}

function packed(value: number): Uint8Array {
  if (value <= 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) return Uint8Array.of(0xfe, value & 0xff, value >> 8);
  return Uint8Array.of(0xff, value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export async function designTypefaceContentId(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  let hex = "";
  for (let index = 0; index < 16; index++) hex += digest[index]!.toString(16).padStart(2, "0");
  return hex;
}

function rewrite(skp: Uint8Array, records: readonly DesignPictureTypefaceRecord[], data: (record: DesignPictureTypefaceRecord) => Uint8Array | null) {
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const record of records) {
    const replacement = data(record);
    if (!replacement) continue;
    parts.push(skp.subarray(cursor, record.dataLengthAt), packed(replacement.length), replacement);
    cursor = record.end;
  }
  parts.push(skp.subarray(cursor));
  return concat(parts);
}

/** Replaces each embedded font file with a reference to its content id and
 * returns those files once each. A picture without embedded fonts, or one
 * whose structure is not understood, comes back unchanged. `contentId` lets a
 * caller reuse ids it has already computed; it must return exactly
 * `designTypefaceContentId(bytes)`, since a reader verifies every font
 * against its id. */
export async function externalizeDesignPictureTypefaces(skp: Uint8Array,
  options: { contentId?: (bytes: Uint8Array) => Promise<string> } = {}):
  Promise<{ skp: Uint8Array; typefaces: Array<{ id: string; bytes: Uint8Array }>; skipped?: string }> {
  let records: DesignPictureTypefaceRecord[];
  try { records = inspectDesignPictureTypefaces(skp); }
  catch (error) { return { skp, typefaces: [], skipped: error instanceof Error ? error.message : String(error) }; }
  const embedded = records.filter((record) => !record.reference && record.dataLength > 0);
  if (!embedded.length) return { skp, typefaces: [] };
  const contentId = options.contentId ?? designTypefaceContentId;
  const ids = await Promise.all(embedded.map((record) => contentId(skp.subarray(record.dataStart, record.dataStart + record.dataLength))));
  const byRecord = new Map(embedded.map((record, index) => [record, ids[index]!]));
  const typefaces = new Map<string, Uint8Array>();
  for (const [record, id] of byRecord) if (!typefaces.has(id))
    typefaces.set(id, skp.slice(record.dataStart, record.dataStart + record.dataLength));
  const encoder = new TextEncoder();
  const references = new Map([...typefaces.keys()].map((id) => [id, concat([Uint8Array.from(DESIGN_TYPEFACE_REFERENCE_MAGIC), encoder.encode(id)])]));
  return {
    skp: rewrite(skp, records, (record) => { const id = byRecord.get(record); return id ? references.get(id)! : null; }),
    typefaces: [...typefaces].map(([id, bytes]) => ({ id, bytes })),
  };
}

/** The exact inverse: references become the font files they name again. A
 * reference without bytes leaves the picture unresolved (null). */
export function internalizeDesignPictureTypefaces(skp: Uint8Array, typeface: (id: string) => Uint8Array | null | undefined): Uint8Array | null {
  const records = inspectDesignPictureTypefaces(skp);
  let unresolved = false;
  const result = rewrite(skp, records, (record) => {
    if (!record.reference) return null;
    const bytes = typeface(record.reference);
    if (!bytes) unresolved = true;
    return bytes ?? null;
  });
  return unresolved ? null : result;
}

/** Content ids a picture refers to, in first-use order. */
export function designPictureTypefaceReferences(skp: Uint8Array): string[] {
  return [...new Set(inspectDesignPictureTypefaces(skp).flatMap((record) => record.reference ? [record.reference] : []))];
}
