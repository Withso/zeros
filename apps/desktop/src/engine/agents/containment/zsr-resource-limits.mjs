/** Generous abuse ceilings shared by macOS and Linux descendants. CPU and
 * memory remain governed by the normal host/container scheduler so ordinary
 * builds keep parity; these hard rlimits prevent fork/FD/core-dump exhaustion
 * of the trusted engine. */
export const ZSR_RESOURCE_LIMITS = Object.freeze({
  processes: 2048,
  openFiles: 32768,
  coreBytes: 0,
  memoryBytes: 3 * 1024 * 1024 * 1024,
  cpuQuotaMicros: 200_000,
  cpuPeriodMicros: 100_000,
});

/** Static POSIX-shell prelude. It clamps to the lower of the host hard limit
 * and the ZSR ceiling, then lowers both soft and hard values so descendants
 * cannot raise them again. No request-authored bytes enter this string. */
export function resourceLimitShell() {
  return [
    "zsr_cap_hard_limit() {",
    '  zsr_limit_flag="$1"; zsr_limit_cap="$2";',
    '  zsr_limit_current="$(ulimit -H "$zsr_limit_flag")" || exit 125;',
    '  case "$zsr_limit_current" in',
    '    unlimited) zsr_limit_target="$zsr_limit_cap" ;;',
    "    ''|*[!0-9]*) exit 125 ;;",
    '    *) if [ "$zsr_limit_current" -gt "$zsr_limit_cap" ]; then zsr_limit_target="$zsr_limit_cap"; else zsr_limit_target="$zsr_limit_current"; fi ;;',
    "  esac;",
    '  ulimit -S "$zsr_limit_flag" "$zsr_limit_target" || exit 125;',
    '  ulimit -H "$zsr_limit_flag" "$zsr_limit_target" || exit 125;',
    "};",
    `zsr_cap_hard_limit -u ${ZSR_RESOURCE_LIMITS.processes};`,
    `zsr_cap_hard_limit -n ${ZSR_RESOURCE_LIMITS.openFiles};`,
    `ulimit -S -c ${ZSR_RESOURCE_LIMITS.coreBytes} || exit 125;`,
    `ulimit -H -c ${ZSR_RESOURCE_LIMITS.coreBytes} || exit 125;`,
    "unset -f zsr_cap_hard_limit 2>/dev/null || true;",
    "unset zsr_limit_flag zsr_limit_cap zsr_limit_current zsr_limit_target;",
    "",
  ].join(" ");
}
