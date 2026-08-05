// ──────────────────────────────────────────────────────────
// Diff CodeView reconciliation version
// ──────────────────────────────────────────────────────────
//
// @pierre/diffs keeps a virtualized item record by `id` and only replaces its
// parsed diff when the numeric `version` changes. FileViewer deliberately uses
// one stable item id, so derive a stable content version from the whole patch.
// Combining two independent 32-bit accumulators gives a safe 53-bit integer;
// equal-length edits no longer collapse onto the same length-based version.
// ──────────────────────────────────────────────────────────

/** Fast, non-cryptographic content version for a unified diff string. */
export function diffViewVersion(patch: string): number {
  let low = 0x811c9dc5;
  let high = 0x9e3779b9;
  for (let index = 0; index < patch.length; index += 1) {
    const code = patch.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193);
    high = Math.imul(high ^ code ^ index, 0x85ebca6b);
  }
  // 21 high bits + 32 low bits stays within Number.MAX_SAFE_INTEGER.
  return (high >>> 11) * 0x1_0000_0000 + (low >>> 0);
}
