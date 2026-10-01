// A subprocess boundary around the existing audited migration command.
// Only its allowlisted JSON receipt reaches the parent, never SQL/driver logs.
import { writeFileSync } from "node:fs";
import { releaseMigration, planetScaleClient, ReleaseMigrationError } from "../../apps/control-plane/src/manage-release-migration";
import { createMigrationPool } from "../../apps/control-plane/src/db";
import { MigrationReceipt, promotionConfig } from "./contracts";

async function main() {
  const config = promotionConfig(process.env);
  if (process.env.NODE_ENV !== "production") throw new Error("production mode required");
  const execute = process.argv[2] === "--execute";
  if (!execute && process.argv[2] !== "--plan") throw new Error("mode required");
  // runMigrations emits filenames; still suppress all dependency output here.
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  const receipt = await releaseMigration({ database: config.database, branch: config.databaseBranch, execute,
    ...(execute ? { confirm: config.database } : {}) }, {
    planetScale: planetScaleClient({ organization: config.organization,
      tokenId: process.env.PLANETSCALE_SERVICE_TOKEN_ID!, token: process.env.PLANETSCALE_SERVICE_TOKEN! }),
    createPool: url => createMigrationPool(url, { role: "postgres", maxConnections: 1, applicationName: "zeros-hosted-promotion" }),
  });
  process.stdout.write(JSON.stringify(MigrationReceipt.parse(receipt)));
}
void main().catch(error => {
  // The controlled cutover reads these allowlisted recovery facts; output stays private.
  const partial = error instanceof ReleaseMigrationError ? error.partial : undefined;
  if (partial && process.env.MIGRATION_FAILURE_FILE) {
    try {
      writeFileSync(process.env.MIGRATION_FAILURE_FILE, JSON.stringify({ backup: partial.backup && { id: partial.backup.id, state: partial.backup.state },
        applied: partial.applied, roleDeleted: partial.roleDeleted }), { mode: 0o600 });
    } catch { /* Recovery facts are best effort. */ }
  }
  process.stderr.write("Release migration failed or owner-role cleanup is unconfirmed. Inspect the target before retrying.\n");
  process.exitCode = 1;
});
