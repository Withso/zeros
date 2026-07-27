/** Reconcile the Changes viewer against a newly confirmed ordered file list.
 *
 * Keep a surviving selection. On first open, choose the first row. If an
 * external edit removes the selected row, prefer the next surviving row from
 * the prior order, then the nearest prior row, then the new first row. This
 * preserves review direction when a terminal/IDE deletes a file in the middle
 * of the list instead of leaving a stale missing-file viewer behind. */
export function reconcileChangesSelection(
  previousPaths: readonly string[],
  nextPaths: readonly string[],
  selectedPath: string | null,
): string | null {
  if (nextPaths.length === 0) return null;
  if (!selectedPath) return nextPaths[0];

  const next = new Set(nextPaths);
  if (next.has(selectedPath)) return selectedPath;

  const previousIndex = previousPaths.indexOf(selectedPath);
  if (previousIndex >= 0) {
    for (
      let index = previousIndex + 1;
      index < previousPaths.length;
      index += 1
    ) {
      if (next.has(previousPaths[index])) return previousPaths[index];
    }
    for (let index = previousIndex - 1; index >= 0; index -= 1) {
      if (next.has(previousPaths[index])) return previousPaths[index];
    }
  }

  return nextPaths[0];
}
