export const RUNTIME_INSTALL_PHASES = ["cache", "lock", "download", "verify", "unpack", "publish", "activate"] as const;
export type RuntimeInstallPhase = typeof RUNTIME_INSTALL_PHASES[number];
export type RuntimeInstallTiming = { phase: RuntimeInstallPhase; durationMs: number; result: "ok" | "failed" };

/** Provider output is untrusted. Only closed numeric markers may reach logs. */
export function readRuntimeInstallTimings(stdout: string): RuntimeInstallTiming[] {
  if (stdout.length > 65_536) return [];
  const records: RuntimeInstallTiming[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^zeros-runtime-timing ([a-z]+) (0|[1-9][0-9]{0,6}) (ok|failed)$/.exec(line);
    if (!match || !(RUNTIME_INSTALL_PHASES as readonly string[]).includes(match[1]!) || Number(match[2]) > 3_600_000) continue;
    records.push({ phase: match[1] as RuntimeInstallPhase, durationMs: Number(match[2]), result: match[3] as "ok" | "failed" });
    if (records.length === 32) break;
  }
  return records;
}

export const runtimeTimingScript = [
  "runtime_phase=; runtime_phase_started=0; runtime_tmp=; runtime_partial=",
  "runtime_end() {",
  '  if [ -n "$runtime_phase" ]; then',
  '    runtime_elapsed=$(( $(date +%s%3N) - runtime_phase_started ))',
  '    if [ "$runtime_elapsed" -ge 0 ] && [ "$runtime_elapsed" -le 3600000 ]; then',
  '      printf "zeros-runtime-timing %s %s %s\\n" "$runtime_phase" "$runtime_elapsed" "$1"',
  "    fi",
  "    runtime_phase=",
  "  fi",
  "}",
  'runtime_begin() { runtime_end ok; runtime_phase=$1; runtime_phase_started=$(date +%s%3N); }',
  "runtime_exit() {",
  "  runtime_status=$?; trap - EXIT",
  '  if [ "$runtime_status" -eq 0 ]; then runtime_end ok; else runtime_end failed; fi',
  // Cleanup must not turn a failed integrity check into a successful command.
  '  if [ -n "$runtime_tmp" ]; then rm -rf "$runtime_tmp" || true; fi',
  '  if [ -n "$runtime_partial" ]; then sudo -n rm -rf "$runtime_partial" || true; fi',
  '  exit "$runtime_status"',
  "}",
  "trap runtime_exit EXIT",
];
