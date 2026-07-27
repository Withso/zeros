// ──────────────────────────────────────────────────────────
// Team logo — client-side image shaping for the team logo.
//
// The backend accepts a data: URL pinned to png/jpeg/webp (never SVG — it
// can carry script) capped at 200k chars (~150 KB decoded). To keep real
// uploads far below that, the picker downscales whatever the user chose
// to a 256×256 cover-cropped square before upload — a menubar-sized logo
// needs nothing more, and it makes "my 8 MB photo won't upload" a
// non-issue. Everything happens in the renderer; the raw file never
// leaves the machine.
// ──────────────────────────────────────────────────────────

/** Mirrors the backend LogoSchema cap. */
export const TEAM_LOGO_MAX_CHARS = 200_000;

/** For <input type="file" accept=…> — decodable raster inputs. (The OUTPUT
 *  mime is always webp/png regardless of input; gif loses animation.) */
export const TEAM_LOGO_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

const OUTPUT_SIZE = 256;

/** Decode, cover-crop to a 256×256 square, and re-encode as a compact
 *  webp (png fallback) data URL. Throws a user-presentable Error when the
 *  file isn't a decodable image or the result is still oversized. */
export async function fileToTeamLogo(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file doesn't look like an image — use a PNG, JPEG, or WebP.");
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side < 1) throw new Error("That image is empty.");
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't process the image — try a different file.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    // webp encodes small; toDataURL silently falls back to png where webp
    // isn't supported, so check the produced mime rather than assuming.
    let url = canvas.toDataURL("image/webp", 0.85);
    if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/png");
    if (url.length > TEAM_LOGO_MAX_CHARS) {
      throw new Error("That image is too detailed to compress — try a simpler one.");
    }
    return url;
  } finally {
    bitmap.close();
  }
}
