import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrationServerVersion, migrationVersionDiagnostic, MINIMUM_POSTGRES_VERSION } from "../../apps/control-plane/src/migration-version";
import { PromotionError } from "./contracts";
import { command as run, type Command } from "./io";

/** The release migration's receipt is its stdout, so nothing else may print
 * there. pnpm writes workspace engine warnings to stdout (apps/cloud-worker
 * wants Node 24; release jobs run Node 22); --silent keeps them out. */
export async function migrationReceipt(execute: boolean, env: NodeJS.ProcessEnv, command: Command = run): Promise<unknown> {
  const directory = execute ? await mkdtemp(path.join(os.tmpdir(), "zeros-migration-version-")) : null;
  const versionFile = directory && path.join(directory, "version.json");
  let version: number | null = null;
  let stdout: string;
  try {
    stdout = await command("pnpm", ["--silent", "exec", "tsx", "scripts/release/migration-cli.ts", execute ? "--execute" : "--plan"],
      { env: versionFile ? { ...env, MIGRATION_VERSION_FILE: versionFile } : env, timeout: 50 * 60_000 });
  } finally {
    if (directory && versionFile) {
      // Generic subprocess output stays private, including on nonzero exits.
      try {
        const record: unknown = JSON.parse(await readFile(versionFile, "utf8"));
        if (record && typeof record === "object" && "serverVersionNum" in record && typeof record.serverVersionNum === "number") {
          version = migrationServerVersion(record.serverVersionNum);
        }
      } catch { /* Missing or malformed evidence remains unknown. */ }
      console.log(migrationVersionDiagnostic(version));
      await rm(directory, { recursive: true, force: true }).catch(() => { /* Preserve the original migration failure. */ });
    }
  }
  if (execute && (version === null || version < MINIMUM_POSTGRES_VERSION)) {
    throw new PromotionError("PostgreSQL version check did not confirm PostgreSQL 16 or newer; release refused. Inspect the target before retrying.");
  }
  try { return JSON.parse(stdout); }
  catch { throw new PromotionError("Release migration receipt was not valid JSON; output withheld. Reconcile the current stage before retrying."); }
}
