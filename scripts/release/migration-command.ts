import { PromotionError } from "./contracts";
import { command as run, type Command } from "./io";

/** The release migration's receipt is its stdout, so nothing else may print
 * there. pnpm writes workspace engine warnings to stdout (apps/cloud-worker
 * wants Node 24; release jobs run Node 22); --silent keeps them out. */
export async function migrationReceipt(execute: boolean, env: NodeJS.ProcessEnv, command: Command = run): Promise<unknown> {
  const stdout = await command("pnpm", ["--silent", "exec", "tsx", "scripts/release/migration-cli.ts", execute ? "--execute" : "--plan"],
    { env, timeout: 50 * 60_000 });
  try { return JSON.parse(stdout); }
  catch { throw new PromotionError("Release migration receipt was not valid JSON; output withheld. Reconcile the current stage before retrying."); }
}
