import { constants } from "node:fs";
import { access, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** The restore marker's content when a fresh-checkpoint recovery replacement wrote it; ordinary restores leave it empty. */
export const RECOVERY_MARKER = "recovery";
/** Durable worker state (excluded from checkpoints): new turns wait until this boot's restored setup succeeds. */
export const RECOVERY_TURN_HOLD = "recovery-turn-hold";

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Before setup starts: a recovery marker creates the hold, and an existing hold (a restart) stays. Returns whether
 * new turns are held. Independent of which control plane later answers a pull. */
export async function openRecoveryTurnHold(directory: string): Promise<boolean> {
  const hold = join(directory, RECOVERY_TURN_HOLD);
  const marker = await readFile(join(directory, "restored-from-checkpoint"), "utf8").then(text => text.trim(), (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  if (marker === RECOVERY_MARKER) {
    const file = await open(hold, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { await file.sync(); } finally { await file.close(); }
    await syncDirectory(directory);
  }
  return access(hold).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  });
}

export async function releaseRecoveryTurnHold(directory: string): Promise<void> {
  await rm(join(directory, RECOVERY_TURN_HOLD), { force: true });
  await syncDirectory(directory);
}
