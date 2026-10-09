import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { sessionsRoot } from "../session-paths";
import type { ExecutionBoundaryRecoveryResult } from "./types";

const MAX_RECOVERY_ENTRIES = 4096;
const EMPTY_RECOVERY: ExecutionBoundaryRecoveryResult = Object.freeze({
  discovered: 0, recovered: 0, active: 0, preserved: 0,
});

export class LegacyExecutionRecoveryRequiredError extends Error {
  readonly code = "legacy_execution_recovery_required";
  constructor(readonly recovery: ExecutionBoundaryRecoveryResult) {
    super("Legacy execution state requires retirement proof from its original runtime.");
    this.name = "LegacyExecutionRecoveryRequiredError";
  }
}

export interface LegacyExecutionRecoveryOptions {
  readonly sessionsRoot?: string;
}

/** Old kernel-domain fingerprints cannot authorize Host process signals. The
 * original runtime must retire them; the new engine only recognizes their
 * durable holds. Malformed records and ambiguous filesystem entries are also
 * holds. No old helper is executed and no PID is inspected or signalled. */
export async function recoverLegacyExecutionProcesses(
  options: LegacyExecutionRecoveryOptions = {},
): Promise<ExecutionBoundaryRecoveryResult> {
  let inspected = 0;
  let preserved = 0;
  const hold = () => { preserved += 1; };
  const fail = () => new LegacyExecutionRecoveryRequiredError(Object.freeze({
    discovered: preserved, recovered: 0, active: 0, preserved,
  }));
  async function physicalEntries(directory: string): Promise<string[]> {
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        hold();
        return [];
      }
      const entries: string[] = [];
      for await (const entry of await opendir(directory)) {
        if (++inspected > MAX_RECOVERY_ENTRIES) {
          hold();
          throw fail();
        }
        if (entry.isSymbolicLink()) {
          hold();
          continue;
        }
        if (entry.isDirectory()) entries.push(entry.name);
      }
      return entries;
    } catch (error) {
      if (error instanceof LegacyExecutionRecoveryRequiredError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") hold();
      return [];
    }
  }
  const root = options.sessionsRoot ?? sessionsRoot();
  for (const session of await physicalEntries(root)) {
    const boundary = path.join(root, session, "boundary");
    for (const generation of await physicalEntries(boundary)) {
      const commands = path.join(boundary, generation, "commands");
      try {
        const metadata = await lstat(commands);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          hold();
          continue;
        }
        // Keep the durable name: .reaped is an existing retirement record,
        // whereas ANY process-domain.json entry remains unproven authority.
        await lstat(path.join(commands, "process-domain.json"));
        hold();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") hold();
      }
    }
  }
  if (preserved > 0) throw fail();
  return EMPTY_RECOVERY;
}

/** Cursor's old state-overlay recovery is independent of execution posture.
 * Recheck legacy holds even when called separately from process recovery so
 * an unproven old domain cannot race promotion or disposal of its state. */
export async function recoverLegacyMutableState(
  options: LegacyExecutionRecoveryOptions = {},
): Promise<ExecutionBoundaryRecoveryResult> {
  await recoverLegacyExecutionProcesses(options);
  const { recoverCursorStateOverlays } = await import("../adapters/cursor-sdk/state-overlay");
  const recovery = await recoverCursorStateOverlays({ sessionsRoot: options.sessionsRoot ?? sessionsRoot() });
  if (recovery.conflicts > 0) {
    console.warn(`[cursor-state] preserved ${recovery.conflicts} crash-recovery conflict(s)`);
  }
  return {
    discovered: recovery.discovered, recovered: recovery.recovered,
    active: 0, preserved: recovery.preserved,
  };
}
