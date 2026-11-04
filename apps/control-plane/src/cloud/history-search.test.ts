import { afterEach, expect, it, vi } from "vitest";
import type { Tx } from "../db.js";
import { mirrorMessageSearch } from "./history-search.js";
import { MESSAGE_SEARCH_DEADLINE_MS, MESSAGE_SEARCH_MAX_BYTES } from "./message-search.js";
import { readCloudV2History } from "./history.js";
import type { CloudV2Store } from "./store.js";

afterEach(() => vi.restoreAllMocks());

it.each(["57014", "XX000"])("preserves the HTTP search error contract for database code %s", async code => {
  const error = Object.assign(new Error("Database query failed"), { code });
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("set_config")) return { rows: [] };
    throw error;
  });
  const store = { searchMessages: () => mirrorMessageSearch({ query } as unknown as Tx, "workspace", { query: "needle" }) } as unknown as CloudV2Store;
  const result = readCloudV2History(store, "workspace", { op: "messages.search", params: { query: "needle" } });
  if (code === "57014") await expect(result).rejects.toMatchObject({ status: 413, code: "SEARCH_LIMIT" });
  else await expect(result).rejects.toBe(error);
});

it("does not restart the deadline after acquiring a database connection", async () => {
  vi.spyOn(Date, "now").mockReturnValue(6000);
  const query = vi.fn(async () => ({ rows: [] }));
  await expect(mirrorMessageSearch({ query } as unknown as Tx, "workspace", { query: "needle" }, 6000))
    .rejects.toMatchObject({ code: "SEARCH_LIMIT" });
  expect(query).not.toHaveBeenCalled();
});

it.each(["budget", "final payload"])("keeps the original deadline after the %s await", async boundary => {
  let now = 1000, scans = 0, payloads = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const row = { ord: "1", chat_id: "chat", msg_id: "message", payload: '{"text":"needle"}', created_at_ms: "1" };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("set_config")) {
      if (boundary === "budget") now += MESSAGE_SEARCH_DEADLINE_MS;
      return { rows: [] };
    }
    if (sql.includes("octet_length")) return { rows: scans++ ? [] : [{ ord: "1", bytes: row.payload.length }] };
    if (++payloads === 2 && boundary === "final payload") now += MESSAGE_SEARCH_DEADLINE_MS;
    return { rows: [row] };
  });
  await expect(mirrorMessageSearch({ query } as unknown as Tx, "workspace", { query: "needle" }))
    .rejects.toMatchObject({ code: "SEARCH_LIMIT" });
  if (boundary === "budget") expect(scans).toBe(0);
  else expect(payloads).toBe(2);
});

it("refuses an oversized payload batch before fetching its contents", async () => {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("set_config")) return { rows: [] };
    expect(sql).toContain("octet_length");
    return { rows: [{ ord: "1", bytes: MESSAGE_SEARCH_MAX_BYTES + 1 }] };
  });
  await expect(mirrorMessageSearch({ query } as unknown as Tx, "workspace", { query: "needle" }))
    .rejects.toMatchObject({ code: "SEARCH_LIMIT" });
  expect(query).toHaveBeenCalledTimes(2);
});

it("uses one decreasing statement budget for every scan and payload fetch", async () => {
  let now = 1000, scans = 0;
  const budgets: number[] = [];
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("set_config")) { budgets.push(Number(params[0])); return { rows: [] }; }
    now += 100;
    if (sql.includes("octet_length")) return { rows: scans++ ? [] : [{ ord: "1", bytes: 17 }] };
    return { rows: [{ ord: "1", chat_id: "chat", msg_id: "message", payload: '{"text":"needle"}', created_at_ms: "1" }] };
  });
  expect(await mirrorMessageSearch({ query } as unknown as Tx, "workspace", { query: "needle" }))
    .toEqual({ hits: [{ chatId: "chat", msgId: "message", payload: '{"text":"needle"}', createdAt: 1 }] });
  expect(budgets).toEqual([5000, 4900, 4800, 4700]);
});
