/** Regenerate the dormant, exact native schema profile. Review every resulting
 * mapping change; running this does not qualify a cut, install support or enroll.
 * Source: the repository's own migrations and native queue constructors. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Sqlite from "better-sqlite3";
import { periodicNativeFixture } from "../../apps/desktop/src/engine/__tests__/fixtures/complete-periodic-native";

const fixture = periodicNativeFixture();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function layout(db: Sqlite.Database) {
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all() as { type: string; name: string; tbl_name: string; sql: string }[];
  return { objectsSha256: hash(objects), tables: Object.fromEntries(objects.filter(row => row.type === "table").map(row => [row.name, {
    columns: (db.prepare(`PRAGMA table_xinfo("${row.name}")`).all() as { name: string }[]).map(column => column.name),
    sqlSha256: hash(row.sql),
  }])) };
}
try {
  const value = { version: 1, kind: "periodic-native-layout", normal: layout(fixture.normal), ledger: layout(fixture.ledger) };
  const file = path.resolve("apps/desktop/src/engine/cloud-complete-checkpoint-layout.json");
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (fs.readFileSync(file, "utf8") !== bytes) throw new Error("complete native layout differs");
  } else fs.writeFileSync(file, bytes);
} finally { fixture.dispose(); }
