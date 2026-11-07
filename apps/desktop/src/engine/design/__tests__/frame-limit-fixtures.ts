export interface FixtureFrame {
  kind: "html";
  source: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z?: number;
}

const hex = (value: number) => value.toString(16).padStart(32, "0");

/** A canonical canvas.json with engine-shaped IDs. The encoder orders the
 * frames record by z, so equal stacking positions interleave across pages. */
export function pagedCanvasFixture(
  pageCount: number,
  perPage: number,
  options: { version?: 1 | 2 } = {},
) {
  const version = options.version ?? 2;
  const pages = Array.from({ length: pageCount }, (_, page) => ({
    id: `page_${hex(page)}`,
    title: `Page ${page + 1}`,
    frames: [] as string[],
    ...(version === 2 ? { folder: `page-${page + 1}` } : {}),
  }));
  const frames: Record<string, FixtureFrame> = {};
  for (let frame = 0; frame < perPage; frame++)
    for (let page = 0; page < pageCount; page++) {
      const id = `frame_${hex(page * 1_000_000 + frame)}`;
      pages[page]!.frames.push(id);
      frames[id] = {
        kind: "html",
        source: `${version === 2 ? `page-${page + 1}/` : ""}frame-${frame}.html`,
        title: `Frame ${frame + 1}`,
        x: (frame % 16) * 640,
        y: Math.floor(frame / 16) * 440,
        width: 560,
        height: 360,
      };
    }
  return { version, id: "main", title: "Zeros - Design", pages, frames };
}
