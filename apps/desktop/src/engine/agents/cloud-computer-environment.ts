import { CloudComputerEnvironmentValuesSchema } from "@zeros/protocol/cloud-agent-execution";
import type { CloudAgentLease } from "./cloud-agent-lease";
import {
  isCredentialRedirectEnvName,
  isRuntimeInjectionEnvName,
} from "../settings/env-names";

/** Merge only in the child admission path. Provider-owned authentication,
 * configuration and runtime locations remain under engine authority. */
export function cloudComputerProcessEnvironment(
  base: Record<string, string>,
  values: Record<string, string> | null | undefined,
  target: "agent" | "terminal",
) {
  if (values == null) return { ...base };
  if (!CloudComputerEnvironmentValuesSchema.safeParse(values).success)
    throw new Error("Cloud environment is invalid");
  const env = { ...base };
  for (const [name, value] of Object.entries(values)) {
    if (isRuntimeInjectionEnvName(name) || isCredentialRedirectEnvName(name))
      throw new Error("Cloud environment is invalid");
    if (
      /^(?:ZEROS_|CONDUCTOR_|GIT_|XDG_)/.test(name) ||
      ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR"].includes(name)
    )
      continue;
    if (
      target === "agent" &&
      /^(?:ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|CURSOR_)/.test(name)
    )
      continue;
    env[name] = value;
  }
  return env;
}

/** Reuse the execution history's encrypted literal set, including env-only
 * turns. The actor owner also prevents reuse of another member's native log. */
export function cloudComputerExecutionHistory(
  lease: Pick<CloudAgentLease, "environment" | "customization">,
) {
  const authority = lease.environment?.history ?? lease.customization?.history;
  return authority
    ? {
        authority,
        secrets: [
          ...Object.values(lease.environment?.values ?? {}),
          ...(lease.customization?.servers ?? []).flatMap(({ server }) =>
            Object.values(
              server.transport === "stdio"
                ? (server.env ?? {})
                : (server.headers ?? {}),
            ),
          ),
        ],
      }
    : undefined;
}
