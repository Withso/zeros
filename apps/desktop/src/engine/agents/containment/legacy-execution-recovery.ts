import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import { countPendingProcessDomainRecovery, sessionsRoot } from "../session-paths";
import type { ExecutionBoundaryRecoveryResult } from "./types";

const MAX_RECOVERY_ENTRIES = 4096;
const EMPTY_RECOVERY: ExecutionBoundaryRecoveryResult = Object.freeze({
  discovered: 0, recovered: 0, active: 0, preserved: 0,
});

export interface LegacyExecutionRecoveryOptions {
  readonly sessionsRoot?: string;
}

/** The removed runtime's kernel fingerprints cannot authorize Host signals.
 * Quarantine legacy records in place: retain the original GC hold and bytes,
 * but never interpret their PIDs as current authority or reject engine startup.
 * This includes malformed records and ambiguous filesystem entries. */
export async function recoverLegacyExecutionProcesses(
  options: LegacyExecutionRecoveryOptions = {},
): Promise<ExecutionBoundaryRecoveryResult> {
  let inspected = 0;
  let preserved = 0;
  let bounded = false;
  const hold = () => { preserved += 1; };
  const visitEntry = () => {
    if (++inspected > MAX_RECOVERY_ENTRIES) {
      bounded = true;
      return false;
    }
    return true;
  };
  async function physicalEntries(directory: string): Promise<string[]> {
    try {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        hold();
        return [];
      }
      const entries: string[] = [];
      for await (const entry of await opendir(directory)) {
        if (!visitEntry()) {
          hold();
          break;
        }
        if (entry.isSymbolicLink()) {
          hold();
          continue;
        }
        if (entry.isDirectory()) entries.push(entry.name);
      }
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") hold();
      return [];
    }
  }
  const root = options.sessionsRoot ?? sessionsRoot();
  for (const session of await physicalEntries(root)) {
    if (bounded) break;
    preserved += await countPendingProcessDomainRecovery(path.join(root, session), visitEntry);
  }
  if (preserved === 0) return EMPTY_RECOVERY;
  console.warn(`[legacy-execution] quarantined ${preserved} unproven recovery entr${preserved === 1 ? "y" : "ies"} in place; startup will continue`);
  return { discovered: preserved, recovered: 0, active: 0, preserved };
}

/** Cursor's old state-overlay recovery is independent of execution posture.
 * Recheck legacy holds even when called separately from process recovery so
 * an unproven old domain cannot race promotion or disposal of its state. */
export async function recoverLegacyMutableState(
  options: LegacyExecutionRecoveryOptions = {},
): Promise<ExecutionBoundaryRecoveryResult> {
  const processes = await recoverLegacyExecutionProcesses(options);
  if (processes.active || processes.preserved) return processes;
  const { recoverCursorStateOverlays } = await import("../adapters/cursor-sdk/state-overlay");
  let recovery;
  try {
    recovery = await recoverCursorStateOverlays({ sessionsRoot: options.sessionsRoot ?? sessionsRoot() });
  } catch {
    console.warn("[cursor-state] preserved unreadable crash-recovery state; startup will continue");
    return { discovered: 1, recovered: 0, active: 0, preserved: 1 };
  }
  if (recovery.conflicts > 0) {
    console.warn(`[cursor-state] preserved ${recovery.conflicts} crash-recovery conflict(s)`);
  }
  return {
    discovered: recovery.discovered, recovered: recovery.recovered,
    active: 0, preserved: recovery.preserved,
  };
}
