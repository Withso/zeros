// ──────────────────────────────────────────────────────────
// Local agent CPU priority
// ──────────────────────────────────────────────────────────
//
// A local agent runs its builds, typechecks and test suites on the user's Mac,
// next to the Zeros UI and everything else the user is doing. Its host starts
// below normal CPU priority (niceness 10), so that work yields under
// contention and still uses every idle core. Cloud agents own their VM and
// keep normal priority. ZEROS_AGENT_CPU_PRIORITY=normal restores normal
// priority for local agents.

export const AGENT_CPU_PRIORITY_ENV = "ZEROS_AGENT_CPU_PRIORITY";

/** The priority a local agent host requests from its execution boundary. */
export function localAgentCpuPriority(
  env: Readonly<Record<string, string | undefined>> = process.env,
): "below-normal" | undefined {
  return env[AGENT_CPU_PRIORITY_ENV]?.trim().toLowerCase() === "normal"
    ? undefined
    : "below-normal";
}
