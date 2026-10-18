import { deflateSync } from "node:zlib";

export function designPreviewPng(width: number, height: number, seed = 0) {
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type);
    const size = Buffer.alloc(4);
    const crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * stride + 1 + x * 4;
      pixels[offset] = (seed * 31 + x * 3) % 256;
      pixels[offset + 1] = (seed * 71 + y * 7) % 256;
      pixels[offset + 2] = (seed * 113 + x + y) % 256;
      pixels[offset + 3] = 255;
    }
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")}`;
}
