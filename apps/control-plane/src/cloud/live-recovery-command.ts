import { z } from "zod";

export const LIVE_RECOVERY_PORT = 41783;
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function liveRecoveryKey(sandboxId: string, bootId: string): string {
  if (!/^bx_[a-z0-9]{4,32}$/.test(sandboxId) || !z.uuid().safeParse(bootId).success) throw new Error("Invalid route recovery binding");
  return `${sandboxId}:host:${LIVE_RECOVERY_PORT}:recovery:${bootId}`;
}

/** The receipt precedes hide. A lost command reply may replay this command,
 * but an interrupted hide is never interpreted as permission to hide again. */
export function liveRecoveryHideCommand(sandboxId: string, bootId: string, expiresAt: number): string {
  const key = liveRecoveryKey(sandboxId, bootId);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error("Invalid route recovery deadline");
  return `bash -c ${quote([
    "set -eu; umask 077",
    "root=/home/user/.local/share/zeros/cloud-worker",
    "exec 9</opt/zeros/runtime/.install.lock",
    "if ! flock -w 5 -x 9; then printf busy; exit 0; fi",
    `if [ "$(date +%s%3N)" -ge ${expiresAt} ]; then printf refused; exit 0; fi`,
    `if [ "$(cat "$root/runtime-boot" 2>/dev/null)" != ${quote(bootId)} ] || ! systemctl is-active --quiet zeros-worker.service; then printf binding_changed; exit 0; fi`,
    "directory=\"$root/route-recovery\"; mkdir -p -- \"$directory\"",
    `receipt="$directory/${bootId}"`,
    "if [ -e \"$receipt\" ]; then",
    "  case \"$(cat \"$receipt\")\" in",
    `    ${quote(`${key} hidden`)}) printf hidden;;`,
    `    ${quote(`${key} pending`)}) printf pending;;`,
    "    *) printf refused;;",
    "  esac; exit 0",
    "fi",
    `printf '%s' ${quote(`${key} pending`)} > "$receipt.next"`,
    "sync -f \"$receipt.next\"; mv -T -- \"$receipt.next\" \"$receipt\"; sync -f \"$directory\"",
    `if ! timeout 20s host hide ${LIVE_RECOVERY_PORT} >/dev/null 2>&1; then printf refused; exit 0; fi`,
    `printf '%s' ${quote(`${key} hidden`)} > "$receipt.next"`,
    "sync -f \"$receipt.next\"; mv -T -- \"$receipt.next\" \"$receipt\"; sync -f \"$directory\"",
    "printf hidden",
  ].join("\n"))}`;
}

export type LiveRecoveryHideState = "hidden" | "pending" | "busy" | "binding_changed" | "refused";
export function liveRecoveryHideState(value: { exitCode: number; timedOut: boolean; stdout: string }): LiveRecoveryHideState {
  if (value.exitCode !== 0 || value.timedOut) return "pending";
  const state = value.stdout.trim();
  return state === "hidden" || state === "pending" || state === "busy" || state === "binding_changed" || state === "refused" ? state : "refused";
}
