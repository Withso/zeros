import { CLOUD_WORKSPACE_RUNTIME_INSTALL_COMMAND } from "./daytona-setup-executor.js";
import { ClosedDiagnosticSchema } from "./runtime-contract.js";
import type { z } from "zod";

export type ClosedDiagnostic = z.infer<typeof ClosedDiagnosticSchema>;
export type BuilderFixedCommand = "install-runtime" | "runtime-self-test" | `computer:${string}`;
export const BUILDER_BASE_STATUS_COMMAND = "/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/bootstrap.py status";
export const RUNTIME_SMOKE_CHECKS = [
  "node_abi", "sqlite_query", "pty_load", "claude_version", "codex_version",
  "cursor_load", "engine_load", "supervisor_idle", "containment_smoke",
] as const;

/** Repository-owned allowlist. C3 adds its computer:* entries here, never in
 * request input or configuration. Runtime paths come from the strict base probe. */
export function builderFixedCommand(command: BuilderFixedCommand, runtimeId: string | null): string | null {
  if (command === "install-runtime") return CLOUD_WORKSPACE_RUNTIME_INSTALL_COMMAND;
  if (command === "runtime-self-test" && /^r1-[a-f0-9]{64}$/.test(runtimeId ?? "")) {
    const root = `/opt/zeros-infra/${runtimeId}`;
    return `${root}/bin/node ${root}/lib/zeros/runtime-self-test.mjs`;
  }
  return null;
}

/** Ignore preceding output and never parse an earlier success after a final
 * error. Even syntactically valid snake_case free text is not a closed check. */
export function parseBuilderDiagnostic(stdout: string, command: BuilderFixedCommand, exitCode: number): ClosedDiagnostic | null {
  try {
    const line = stdout.replace(/\r?\n$/, "").split("\n").at(-1)!;
    if (Buffer.byteLength(line) > 4096) return null;
    const parsed = ClosedDiagnosticSchema.safeParse(JSON.parse(line));
    if (!parsed.success) return null;
    const value = parsed.data;
    if (value.exitCode !== exitCode || (value.ok && (exitCode !== 0 || value.timedOut || value.failedChecks.length > 0)) ||
        (!value.ok && value.failedChecks.length === 0)) return null;
    if (command === "install-runtime")
      return value.component === "installer" && (!value.ok || value.stage === "done") ? value : null;
    if (command === "runtime-self-test" && value.component === "qualification" && value.stage === "self_test" &&
        value.failedChecks.every(check => (RUNTIME_SMOKE_CHECKS as readonly string[]).includes(check))) return value;
    return null;
  } catch { return null; }
}
