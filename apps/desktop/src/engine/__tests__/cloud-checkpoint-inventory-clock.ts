import { vi } from "vitest";
import * as sqlite from "../db/sqlite";

/** Real SQLite results with deterministic elapsed disk-read time. No sleeps,
 * modified inventory bytes, or mocked proof/checkpoint verification. */
export function checkpointReadClock(elapsed: (sql: string, rows: unknown[], read: {
  file: string; method: "all" | "get";
}) => number) {
  let milliseconds = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => milliseconds);
  const open = sqlite.openSqlite;
  vi.spyOn(sqlite, "openSqlite").mockImplementation((...input) => {
    const db = open(...input), prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql), all = statement.all.bind(statement), get = statement.get.bind(statement);
      const normalized = sql.replace(/\s+/g, " ").trim();
      vi.spyOn(statement, "all").mockImplementation((...parameters) => {
        const rows = all(...parameters);
        milliseconds += elapsed(normalized, rows, { file: input[0], method: "all" });
        return rows;
      });
      vi.spyOn(statement, "get").mockImplementation((...parameters) => {
        const row = get(...parameters);
        milliseconds += elapsed(normalized, row === undefined ? [] : [row], { file: input[0], method: "get" });
        return row;
      });
      return statement;
    });
    return db;
  });
  return { elapsed: () => milliseconds, restore: () => { now.mockRestore(); vi.restoreAllMocks(); } };
}
