// Original, generated TrueType fixture: one rectangular U+0041 outline and an
// empty .notdef glyph. No upstream font data, font compiler or downloads. Each
// family also has distinct full, unique and PostScript names so fontconfig
// never has to reconcile duplicate bitmap/XLFD identities across packages.
export function scalableFont(family: string): Buffer {
  const u16 = (...values: number[]) => {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16BE(value & 0xffff, index * 2));
    return bytes;
  };
  const u32 = (...values: number[]) => {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => bytes.writeUInt32BE(value >>> 0, index * 4));
    return bytes;
  };
  const postscript = `${family.replaceAll(/[^A-Za-z0-9-]/g, "")}-Regular`;
  const names: [number, string][] = [
    [1, family], [2, "Regular"], [3, `${postscript}:1.0`],
    [4, `${family} Regular`], [5, "Version 1.0"], [6, postscript],
    [16, family], [17, "Regular"],
  ];
  const strings = names.map(([, value]) => Buffer.from(value, "utf16le").swap16());
  let stringOffset = 0;
  const records = names.map(([id], index) => {
    const record = u16(3, 1, 0x0409, id, strings[index].length, stringOffset);
    stringOffset += strings[index].length;
    return record;
  });
  const tables: Record<string, Buffer> = {
    // OS/2 v0 metrics, unrestricted embedding, Basic Latin, regular face.
    "OS/2": Buffer.concat([
      u16(0, 500, 400, 5, 0, 650, 600, 0, 75, 650, 600, 0, 350, 50, 250, 0),
      Buffer.alloc(10), u32(1, 0, 0, 0), Buffer.from("ZERO"),
      u16(0x40, 65, 65, 800, -200, 0, 800, 200),
    ]),
    // Windows Unicode BMP, format 4: U+0041 -> glyph 1; sentinel -> .notdef.
    cmap: Buffer.concat([u16(0, 1, 3, 1), u32(12),
      u16(4, 32, 0, 4, 4, 1, 0, 65, 0xffff, 0, 65, 0xffff, -64, 1, 0, 0)]),
    // One contour, four on-curve points, no hinting; signed coordinate deltas.
    glyf: Buffer.concat([u16(1, 0, 0, 500, 700, 3, 0), Buffer.from([1, 1, 1, 1]),
      u16(0, 500, 0, -500, 0, 0, 700, 0)]),
    head: Buffer.concat([u32(0x10000, 0x10000, 0, 0x5f0f3cf5), u16(0, 1000),
      Buffer.alloc(16), u16(0, 0, 500, 700, 0, 8, 2, 0, 0)]),
    hhea: Buffer.concat([u32(0x10000), u16(800, -200, 0, 600, 0, 100, 500, 1, 0, 0),
      Buffer.alloc(8), u16(0, 2)]),
    hmtx: u16(600, 0, 600, 0),
    loca: u16(0, 0, 17), // Short offsets: empty .notdef, then 34-byte outline.
    maxp: Buffer.concat([u32(0x10000), u16(2, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)]),
    name: Buffer.concat([u16(0, names.length, 6 + names.length * 12), ...records, ...strings]),
    post: Buffer.concat([u32(0x30000, 0), u16(-100, 50), u32(0, 0, 0, 0, 0)]),
  };
  const checksum = (bytes: Buffer) => {
    const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4); bytes.copy(padded);
    let sum = 0;
    for (let index = 0; index < padded.length; index += 4) sum = (sum + padded.readUInt32BE(index)) >>> 0;
    return sum;
  };
  const entries = Object.entries(tables).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const selector = Math.floor(Math.log2(entries.length));
  const font = Buffer.alloc(12 + entries.length * 16 + entries.reduce((size, [, bytes]) => size + Math.ceil(bytes.length / 4) * 4, 0));
  Buffer.concat([u32(0x10000), u16(entries.length, 2 ** selector * 16, selector, entries.length * 16 - 2 ** selector * 16)]).copy(font);
  let offset = 12 + entries.length * 16, headOffset = 0;
  entries.forEach(([tag, bytes], index) => {
    Buffer.concat([Buffer.from(tag), u32(checksum(bytes), offset, bytes.length)]).copy(font, 12 + index * 16);
    bytes.copy(font, offset);
    if (tag === "head") headOffset = offset;
    offset += Math.ceil(bytes.length / 4) * 4;
  });
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  return font;
}
