import type {
  ContextUsageCategory,
  UsageUpdateNotification,
} from "@zeros/protocol/agent-events";

type Snapshot = Pick<UsageUpdateNotification, "size" | "used" | "categories">;
type ClassifiedCategory = ContextUsageCategory & {
  kind: NonNullable<ContextUsageCategory["kind"]>;
};

/** Only older peers lack kind. Native classification always wins over names. */
function classify(category: ContextUsageCategory): ClassifiedCategory[] {
  if (
    !category ||
    typeof category.name !== "string" ||
    !category.name.trim() ||
    !Number.isFinite(category.tokens) ||
    category.tokens < 0
  )
    return [];
  const name = category.name.trim();
  const kind =
    category.kind ??
    (/\(deferred\)$/i.test(name)
      ? "deferred"
      : /^free space$/i.test(name)
        ? "free"
        : /^(auto)?compact buffer$/i.test(name)
          ? "buffer"
          : "used");
  if (
    kind !== "used" &&
    kind !== "free" &&
    kind !== "buffer" &&
    kind !== "deferred"
  )
    return [];
  return [{ name, tokens: category.tokens, kind }];
}

/** One list of window contents and reserve. Deferred schemas stay in the
 * snapshot for semantics, but occupy no space and have no row in this UI. */
export function contextGaugeData(usage: Snapshot | null | undefined) {
  const size = usage?.size;
  const used = usage?.used;
  if (
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    size <= 0 ||
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    used < 0
  )
    return null;

  const categories = (
    Array.isArray(usage?.categories) ? usage.categories : []
  ).flatMap(classify);
  const byTokens = (a: ClassifiedCategory, b: ClassifiedCategory) =>
    b.tokens - a.tokens;
  const usedRows = categories
    .filter((c) => c.kind === "used" && c.tokens > 0)
    .sort(byTokens);
  const bufferRows = categories
    .filter((c) => c.kind === "buffer" && c.tokens > 0)
    .sort(byTokens);
  const buffer = bufferRows.reduce(
    (sum, row) => Math.min(size, sum + row.tokens),
    0,
  );
  // Prefer native free space (including zero). Summary category estimates can
  // differ from total used; never rebuild that authoritative total from rows.
  // Missing free space must exclude reserve; explicit free already excludes it.
  const nativeFree = categories.find((c) => c.kind === "free")?.tokens;
  const free =
    used >= size
      ? 0
      : Math.min(
          size - buffer,
          nativeFree ?? Math.max(0, size - used - buffer),
        );
  const rows: ClassifiedCategory[] = [
    { name: "Free space", tokens: free, kind: "free" },
    ...(usedRows.length
      ? usedRows
      : [{ name: "Used", tokens: used, kind: "used" as const }]),
    ...bufferRows,
  ];
  return { size, used, fraction: Math.min(1, used / size), rows };
}
