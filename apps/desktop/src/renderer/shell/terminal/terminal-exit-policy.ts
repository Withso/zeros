import type { PtyExitReason } from "@zeros/protocol/messages";

export type TerminalExitPolicy =
  | { restartBlocked: false }
  | { restartBlocked: true; detail: string; recovery: string };

/** Decide whether a keypress can usefully restart a terminal. Ordinary shell
 * exits and a transient host loss remain restartable. Deterministic failures
 * that happened before a shell existed require an external repair/restart. */
export function terminalExitPolicy(
  reason?: PtyExitReason,
): TerminalExitPolicy {
  if (reason === "spawn-failed") {
    return {
      restartBlocked: true,
      detail: "the shell process could not be launched",
      recovery:
        "Check the workspace path and configured shell, then restart Zeros.",
    };
  }
  if (reason === "host-unavailable") {
    return {
      restartBlocked: true,
      detail: "the terminal host is unavailable",
      recovery: "Restart Zeros after installing the latest update.",
    };
  }
  return { restartBlocked: false };
}
