// Bounded policies for dependency/generated-file-sized Changes views.

/** Above this count, whole-tree Git reads return metadata and the selected
 * file loads its patch separately. This also gates list virtualization. */
export const LARGE_CHANGE_FILE_LIMIT = 1_000;

const EAGER_UNTRACKED_READ_LIMIT = 32;
const CHANGE_ROW_HEIGHT = 28;
const CHANGE_ROW_OVERSCAN = 12;

export interface VisibleChangeWindow {
  start: number;
  end: number;
  offset: number;
  totalHeight: number;
}

/** Fixed-height window for the flat Changes list. `end` is exclusive. */
export function visibleChangeWindow({
  itemCount,
  scrollTop,
  viewportHeight,
}: {
  itemCount: number;
  scrollTop: number;
  viewportHeight: number;
}): VisibleChangeWindow {
  const count = Math.max(0, Math.floor(itemCount));
  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const height = Math.max(
    CHANGE_ROW_HEIGHT,
    Number.isFinite(viewportHeight) ? viewportHeight : 0,
  );
  const first = Math.floor(top / CHANGE_ROW_HEIGHT);
  const visible = Math.ceil(height / CHANGE_ROW_HEIGHT);
  const start = Math.max(0, first - CHANGE_ROW_OVERSCAN);
  const end = Math.min(count, first + visible + CHANGE_ROW_OVERSCAN);
  return {
    start,
    end,
    offset: start * CHANGE_ROW_HEIGHT,
    totalHeight: count * CHANGE_ROW_HEIGHT,
  };
}

/** Warm only a small likely window of untracked content. Shallow paths are
 * prioritized so a handful of user-created root/source files do not sit behind
 * thousands of generated dependency files in the status order. */
export function eagerUntrackedPaths(
  paths: readonly string[],
): ReadonlySet<string> {
  if (paths.length <= EAGER_UNTRACKED_READ_LIMIT) return new Set(paths);
  const ranked = paths.map((path, index) => ({
    path,
    index,
    depth: path.split("/").length - 1,
  }));
  ranked.sort(
    (left, right) => left.depth - right.depth || left.index - right.index,
  );
  return new Set(
    ranked.slice(0, EAGER_UNTRACKED_READ_LIMIT).map((entry) => entry.path),
  );
}
