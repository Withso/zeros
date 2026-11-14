import { z } from "zod";
import { checkpointCommand } from "./checkpoint.js";

type Binding = { id: string; bootId: string; deadline: number };
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

function fence(input: Binding): string[] {
  if (!z.uuid().safeParse(input.id).success || !z.uuid().safeParse(input.bootId).success ||
    !Number.isSafeInteger(input.deadline) || input.deadline <= 0) throw new Error("Invalid recovery command binding");
  return [
    "set -euo pipefail; umask 077",
    "exec 3>&1 >/dev/null 2>&1",
    "refuse() { printf 'zeros-recovery-refused\\n' >&3; exit 0; }",
    "exec 9</opt/zeros/runtime/.install.lock",
    "flock -w 5 -x 9 || refuse",
    `[ "$(date +%s%3N)" -lt ${input.deadline} ] || refuse`,
    "root=/home/user/.local/share/zeros/cloud-worker",
    `[ "$(cat "$root/runtime-boot")" = ${quote(input.bootId)} ] || refuse`,
    "directory=\"$root/recovery-shutdown\"",
    `receipt="$directory/${input.id}"`,
    `expected=${quote(`${input.id} ${input.bootId} stopped`)}`,
    "stopped() {",
    "  local active='' main='' control='' group='' key value state",
    "  state=$(systemctl show zeros-worker.service --property=ActiveState --property=MainPID --property=ControlPID --property=ControlGroup) || return 1",
    "  while IFS='=' read -r key value; do",
    "    case \"$key\" in ActiveState) active=$value;; MainPID) main=$value;; ControlPID) control=$value;; ControlGroup) group=$value;; esac",
    "  done <<< \"$state\"",
    "  [ \"$active\" = inactive ] && [ \"$main\" = 0 ] && [ \"$control\" = 0 ] || return 1",
    "  [ -z \"$group\" ] || [ \"$group\" = /system.slice/zeros-worker.service ] || return 1",
    // populated includes every descendant cgroup, even after the leader exits.
    "  if [ -d /sys/fs/cgroup/system.slice/zeros-worker.service ]; then",
    "    grep -qx 'populated 0' /sys/fs/cgroup/system.slice/zeros-worker.service/cgroup.events || return 1",
    "  fi",
    "  [ \"$(systemctl is-enabled zeros-worker.service || true)\" = disabled ]",
    "}",
  ];
}

/** The install lock also fences token delivery. Replay verifies the same
 * boot is still stopped; a receipt alone cannot certify a restarted unit. */
export function recoveryShutdownCommand(input: Binding): string {
  return `bash -c ${quote([
    ...fence(input),
    "if [ -e \"$receipt\" ]; then",
    "  [ \"$(cat \"$receipt\")\" = \"$expected\" ] && stopped || refuse",
    "else",
    "  sudo -n systemctl disable zeros-worker.service || refuse",
    "  timeout 60s sudo -n systemctl stop zeros-worker.service || refuse",
    "  stopped || refuse",
    "  mkdir -p -- \"$directory\"; printf %s \"$expected\" > \"$receipt.next\"",
    "  sync -f \"$receipt.next\"; mv -T -- \"$receipt.next\" \"$receipt\"; sync -f \"$directory\"",
    "fi",
    "printf 'zeros-recovery-stopped\\n' >&3",
  ].join("\n"))}`;
}

export function recoveryShutdownResult(result: { exitCode: number; timedOut: boolean; stdout: string }): boolean {
  return result.exitCode === 0 && !result.timedOut && result.stdout.trim() === "zeros-recovery-stopped";
}

/** Keep the shutdown fence for the whole archive/upload and force new bytes,
 * even when a caller happens to hold the prior Stop checkpoint fingerprint. */
export function recoveryCheckpointCommand(input: Binding & Omit<Parameters<typeof checkpointCommand>[0], "reuse">): string {
  return `bash -c ${quote([
    ...fence(input),
    "[ -f \"$receipt\" ] && [ \"$(cat \"$receipt\")\" = \"$expected\" ] && stopped || refuse",
    `${checkpointCommand({ ...input, reuse: null })} >&3`,
  ].join("\n"))}`;
}
