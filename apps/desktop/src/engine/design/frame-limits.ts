import { DESIGN_MAX_FRAMES_PER_PAGE } from "@zeros/protocol/design-pages";

const count = (value: number) => value.toLocaleString("en-US");

/** Reads fail closed with this reason; storage is never truncated to fit. */
export function designPageOverLimitMessage(title: string, frames: number): string {
  return `Design page ${JSON.stringify(title)} has ${count(frames)} frames; a page holds at most ${count(DESIGN_MAX_FRAMES_PER_PAGE)}. Move some to another page or remove them, then refresh Design.`;
}

export function assertDesignPageHasRoom(title: string, frames: number): void {
  if (frames >= DESIGN_MAX_FRAMES_PER_PAGE)
    throw new Error(
      `Design page ${JSON.stringify(title)} already has ${count(DESIGN_MAX_FRAMES_PER_PAGE)} frames, the most a page holds. Add the frame to another page.`,
    );
}

/** Raw authored shapes only: the schema reports anything malformed. */
export function assertDesignPagesWithinFrameLimit(
  pages: ReadonlyArray<{ title?: unknown; id?: unknown; frames?: unknown }>,
): void {
  for (const page of pages) {
    if (Array.isArray(page.frames) && page.frames.length > DESIGN_MAX_FRAMES_PER_PAGE)
      throw new Error(
        designPageOverLimitMessage(
          typeof page.title === "string" ? page.title : String(page.id ?? "Design"),
          page.frames.length,
        ),
      );
  }
}
