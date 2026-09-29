import { randomUUID } from "node:crypto";
import { z } from "zod";

/** Deliberate remote mutation, restricted to an explicitly named disposable
 * test repository. Remote branches remain for evidence/admin cleanup because
 * native credentials deliberately cannot delete refs. Never enabled by default. */
export function nativeGithubQualification(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.ZEROS_CLOUD_NATIVE_GITHUB_WRITE_SMOKE !== "1") return null;
  const repository = z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .parse(env.ZEROS_CLOUD_NATIVE_GITHUB_TEST_REPOSITORY);
  const prefix = `zeros-qualification/${randomUUID()}`;
  const checkRepository = `case "$(git remote get-url origin)" in 'https://github.com/${repository}'|'https://github.com/${repository}.git'|'git@github.com:${repository}.git') ;; *) exit 1 ;; esac`;
  const noGh = 'if [ -n "${GH_TOKEN-}" ] || [ -n "${GH_CONFIG_DIR-}" ] || command -v gh >/dev/null 2>&1; then exit 1; fi';
  const command = (branch: string) =>
    `(set -eu; ${checkRepository}; ${noGh}; starting=$(git symbolic-ref --short HEAD); trap 'git switch -- "$starting" >/dev/null' EXIT; git switch -c '${branch}'; git push --set-upstream origin '${branch}'; git fetch origin)`;
  return {
    agentCommand: command(`${prefix}-agent`),
    terminalCommand: command(`${prefix}-terminal`),
    verifyAgentCommand: `(set -eu; ${checkRepository}; ${noGh}; test "$(git ls-remote --heads origin 'refs/heads/${prefix}-agent' | cut -f1)" = "$(git rev-parse HEAD)")`,
  };
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export class NativeGithubEvidence {
  private readonly calls = new Map<string, Record<string, unknown>>();
  constructor(private readonly command: string) {}
  observe(value: unknown) {
    const update = record(value);
    if (
      !["tool_call", "tool_call_update"].includes(
        String(update.sessionUpdate),
      ) ||
      typeof update.toolCallId !== "string"
    )
      return;
    if (this.calls.size >= 2048)
      throw new Error(
        "Native GitHub qualification evidence exceeded its bound",
      );
    const row = this.calls.get(update.toolCallId) ?? {};
    for (const key of [
      "nativeToolCallId",
      "kind",
      "rawInput",
      "status",
      "title",
    ])
      if (update[key] != null) row[key] = update[key];
    this.calls.set(update.toolCallId, row);
  }
  assert() {
    const quoted = `'${this.command.replaceAll("'", `'"'"'`)}'`;
    const commands = [
      this.command,
      ...["bash", "/bin/bash", "/usr/bin/bash", "sh", "/bin/sh"].flatMap(
        (shell) => ["-c", "-lc"].map((flag) => `${shell} ${flag} ${quoted}`),
      ),
    ];
    for (const call of this.calls.values()) {
      const input = record(call.rawInput);
      if (
        call.kind === "execute" &&
        call.status === "completed" &&
        typeof call.nativeToolCallId === "string" &&
        input.server === undefined &&
        input.providerIdentifier === undefined &&
        !String(call.title).startsWith("mcp__") &&
        commands.includes(String(input.command))
      )
        return;
    }
    throw new Error(
      "Qualification lacks a successful native connected-account Git push",
    );
  }
}
