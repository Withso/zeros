import {
  CONTEXT_USAGE_CATEGORY_IDS,
  type ContextUsageCategory,
  type ContextUsageCategoryId,
  type ContextUsageMcpServer,
  type UsageUpdateNotification,
} from "./agent-events";

export type ClassifiedContextUsageCategory = ContextUsageCategory & {
  kind: NonNullable<ContextUsageCategory["kind"]>;
};

const ids: ReadonlySet<string> = new Set(CONTEXT_USAGE_CATEGORY_IDS);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function contextUsageCategoryId(
  value: unknown,
): ContextUsageCategoryId | undefined {
  return typeof value === "string" && ids.has(value)
    ? (value as ContextUsageCategoryId)
    : undefined;
}

/** Stable IDs win. Names are only the compatibility path for old snapshots or
 * an unrecognized future ID, never a reason to reinterpret a known ID. */
export function contextUsageCategoryIdentity(
  category: Pick<ContextUsageCategory, "id" | "name">,
): ContextUsageCategoryId | undefined {
  const id = contextUsageCategoryId(category.id);
  if (id) return id;
  switch (category.name.trim().toLowerCase()) {
    case "mcp tools":
      return "mcp_tools";
    case "mcp server instructions":
    case "mcp instructions":
      return "mcp_instructions";
    case "mcp tools (deferred)":
      return "mcp_tools_deferred";
    case "free space":
      return "free_space";
    case "autocompact buffer":
      return "autocompact_buffer";
    case "compact buffer":
      return "compact_buffer";
    default:
      return undefined;
  }
}

function serverTotals(
  value: unknown,
  loadedOnly = false,
): ContextUsageMcpServer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const totals = new Map<string, number>();
  for (const entry of value) {
    const row = record(entry);
    if (loadedOnly && row.isLoaded === false) continue;
    // A partial malformed split cannot safely attribute the whole row. Keep
    // the category itself, but let the renderer fall back to its ordinary row.
    if (
      typeof row.serverName !== "string" ||
      !row.serverName.trim() ||
      !count(row.tokens)
    )
      return undefined;
    const tokens = (totals.get(row.serverName) ?? 0) + row.tokens;
    if (!Number.isFinite(tokens)) return undefined;
    totals.set(row.serverName, tokens);
  }
  return [...totals]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([serverName, tokens]) => ({ serverName, tokens }));
}

export function classifyContextUsageCategory(
  value: unknown,
): ClassifiedContextUsageCategory | null {
  const category = record(value);
  if (
    typeof category.name !== "string" ||
    !category.name.trim() ||
    !count(category.tokens)
  )
    return null;
  const name = category.name.trim(),
    id = contextUsageCategoryId(category.id);
  const identity = contextUsageCategoryIdentity({ id, name });
  const kind =
    category.kind ??
    (category.isDeferred ||
    identity === "mcp_tools_deferred" ||
    identity === "system_tools_deferred" ||
    (!id && /\(deferred\)$/i.test(name))
      ? "deferred"
      : identity === "free_space"
        ? "free"
        : identity === "autocompact_buffer" || identity === "compact_buffer"
          ? "buffer"
          : "used");
  if (
    kind !== "used" &&
    kind !== "free" &&
    kind !== "buffer" &&
    kind !== "deferred"
  )
    return null;
  const mcpServers = serverTotals(category.mcpServers);
  return {
    ...(id ? { id } : {}),
    name,
    tokens: category.tokens,
    kind,
    ...(mcpServers ? { mcpServers } : {}),
  };
}

/** Provider-shaped input, without importing either host's SDK/runtime. Both
 * Local and the standalone worker publish this same backward-compatible wire. */
export function mapClaudeContextUsage(
  value: unknown,
): UsageUpdateNotification | null {
  const usage = record(value),
    size = usage.maxTokens,
    used = usage.totalTokens;
  if (!count(size) || size <= 0 || !count(used)) return null;
  const categories = (
    Array.isArray(usage.categories) ? usage.categories : []
  ).flatMap((value) => {
    const category = classifyContextUsageCategory(value);
    return category ? [category] : [];
  });
  const deferred = categories.some(
    (category) =>
      category.kind === "deferred" &&
      category.tokens > 0 &&
      contextUsageCategoryIdentity(category) === "mcp_tools_deferred",
  );
  // In the bundled CLI, isLoaded=false can still occupy the used MCP row when
  // tool search is disabled. Exclude it only when native accounting defers it.
  const tools = serverTotals(usage.mcpTools, deferred);
  const instructions = serverTotals(usage.mcpInstructions);
  return {
    sessionUpdate: "usage_update",
    size,
    used,
    categories: categories.map((category) => {
      const identity = contextUsageCategoryIdentity(category);
      const mcpServers =
        category.kind === "used"
          ? identity === "mcp_tools"
            ? tools
            : identity === "mcp_instructions"
              ? instructions
              : undefined
          : undefined;
      return mcpServers ? { ...category, mcpServers } : category;
    }),
  };
}
