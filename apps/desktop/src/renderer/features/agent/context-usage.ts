import type {
  ContextUsageCategoryId,
  UsageUpdateNotification,
} from "@zeros/protocol/agent-events";
import {
  classifyContextUsageCategory,
  contextUsageCategoryIdentity,
  type ClassifiedContextUsageCategory,
} from "@zeros/protocol/context-usage";

type Snapshot = Pick<UsageUpdateNotification, "size" | "used" | "categories">;
export interface ContextGaugeServer {
  key: string;
  name: string;
  tokens: number;
  percentageTenths: number;
}

export interface ContextGaugeRow extends Omit<
  ClassifiedContextUsageCategory,
  "id"
> {
  id?: ContextUsageCategoryId | "mcp_servers";
  servers?: ContextGaugeServer[];
  percentageTenths?: number;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byTokens = (a: { tokens: number }, b: { tokens: number }) =>
  b.tokens - a.tokens;

/** Native per-tool estimates can round independently of their category total.
 * Largest remainders conserve that authoritative budget, also for displayed
 * tenths of a percent. Input order is canonical so ties do not move row keys. */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((weight) => (weight / sum) * total);
  const result = exact.map(Math.floor);
  let remaining = total - result.reduce((a, b) => a + b, 0);
  const order = exact
    .map((_, index) => index)
    .sort((a, b) => exact[b] - result[b] - (exact[a] - result[a]) || a - b);
  for (const index of order) {
    if (remaining <= 0) break;
    const share = Math.min(1, remaining);
    result[index] += share;
    remaining -= share;
  }
  return result;
}

function groupMcpRows(
  rows: ClassifiedContextUsageCategory[],
  size: number,
): ContextGaugeRow[] {
  const mcp = rows.filter((row) => {
    const id = contextUsageCategoryIdentity(row);
    return id === "mcp_tools" || id === "mcp_instructions";
  });
  if (
    !mcp.length ||
    mcp.some(
      (row) =>
        !row.mcpServers?.length ||
        !Number.isFinite(
          row.mcpServers.reduce((sum, server) => sum + server.tokens, 0),
        ) ||
        !row.mcpServers.some((server) => server.tokens > 0),
    )
  )
    return rows;
  const total = mcp.reduce((sum, row) => sum + row.tokens, 0);
  const percentageTenths = Math.round((total / size) * 1000);
  if (!Number.isFinite(total) || !Number.isFinite(percentageTenths))
    return rows;
  const tools = new Map<string, number>(),
    instructions = new Map<string, number>();
  for (const row of mcp) {
    const target =
      contextUsageCategoryIdentity(row) === "mcp_tools" ? tools : instructions;
    const shares = apportion(
      row.tokens,
      row.mcpServers!.map((server) => server.tokens),
    );
    row.mcpServers!.forEach((server, index) =>
      target.set(
        server.serverName,
        (target.get(server.serverName) ?? 0) + shares[index],
      ),
    );
  }
  const candidates = new Map<
    string,
    Array<{ raw: string; joinable: boolean }>
  >();
  for (const raw of instructions.keys()) {
    // CLI 2.1.309 normalizes each non-ASCII-name character to '_', preserving
    // case. Its context report then takes tool.name.split('__')[1]. Names
    // containing that delimiter can be truncated; never guess that join.
    const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
    const reported = normalized.split("__")[0] || "unknown";
    candidates.set(reported, [
      ...(candidates.get(reported) ?? []),
      { raw, joinable: normalized === reported },
    ]);
  }
  const servers = new Map<
    string,
    Omit<ContextGaugeServer, "percentageTenths">
  >();
  for (const [name, tokens] of tools)
    servers.set(`tools:${name}`, { key: `tools:${name}`, name, tokens });
  for (const [raw, tokens] of instructions) {
    const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
    const matches = candidates.get(normalized);
    const tool =
      matches?.length === 1 && matches[0].joinable
        ? servers.get(`tools:${normalized}`)
        : undefined;
    if (tool) {
      tool.name = raw;
      tool.tokens += tokens;
    } else
      servers.set(`instructions:${raw}`, {
        key: `instructions:${raw}`,
        name: raw,
        tokens,
      });
  }
  const positive = [...servers.values()]
    .filter((server) => server.tokens > 0)
    .sort((a, b) => byText(a.key, b.key));
  const labels = new Map<string, number>();
  for (const server of positive)
    labels.set(server.name, (labels.get(server.name) ?? 0) + 1);
  const percentages = apportion(
    percentageTenths,
    positive.map((server) => server.tokens),
  );
  const children = positive
    .map((server, index) => ({
      ...server,
      name:
        labels.get(server.name)! > 1
          ? `${server.name} (${server.key.startsWith("tools:") ? "tools" : "instructions"})`
          : server.name,
      percentageTenths: percentages[index],
    }))
    .sort((a, b) => byTokens(a, b) || byText(a.key, b.key));
  return [
    ...rows.filter((row) => !mcp.includes(row)),
    {
      id: "mcp_servers",
      name: "MCP servers",
      kind: "used",
      tokens: total,
      servers: children,
      percentageTenths,
    },
  ];
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
  ).flatMap((value) => {
    const category = classifyContextUsageCategory(value);
    return category ? [category] : [];
  });
  const usedRows = groupMcpRows(
    categories.filter((c) => c.kind === "used" && c.tokens > 0),
    size,
  ).sort(byTokens);
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
  const nativeFreeRow = categories.find((c) => c.kind === "free");
  const nativeFree = nativeFreeRow?.tokens;
  const free =
    used >= size
      ? 0
      : Math.min(
          size - buffer,
          nativeFree ?? Math.max(0, size - used - buffer),
        );
  const rows: ContextGaugeRow[] = [
    {
      ...(nativeFreeRow?.id ? { id: nativeFreeRow.id } : {}),
      name: "Free space",
      tokens: free,
      kind: "free",
    },
    ...(usedRows.length
      ? usedRows
      : [{ name: "Used", tokens: used, kind: "used" as const }]),
    ...bufferRows,
  ];
  return { size, used, fraction: Math.min(1, used / size), rows };
}
