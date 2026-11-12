import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { parseEnv } from "node:util";
import { CLOUD_ENVIRONMENT_LIMITS, isCloudReservedEnvironmentName, type CloudWorkspaceEnvironment } from "@zeros/protocol/cloud-v2-relay";

const bytes = (value: string) => Buffer.byteLength(value, "utf8");
/** Why an env-file entry is not a variable too (the same rules as the control plane's variables); undefined: exportable. */
const unexported = (name: string, value: string): keyof Unexported | undefined =>
  !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || bytes(name) > CLOUD_ENVIRONMENT_LIMITS.nameBytes || value.includes("\0") ? "invalid"
    : isCloudReservedEnvironmentName(name) ? "reserved" : bytes(value) > CLOUD_ENVIRONMENT_LIMITS.valueBytes ? "limit" : undefined;
/** Env-file entries written to the file but not exported as variables, by class (counts only). */
export interface Unexported { reserved: number; invalid: number; limit: number }
/** The worker journal line when any entry was not exported (counts only). */
export const unexportedLine = (skipped: Unexported): string | undefined => skipped.reserved + skipped.invalid + skipped.limit
  ? `personal-env unexported reserved=${skipped.reserved} invalid=${skipped.invalid} limit=${skipped.limit}` : undefined;
/** One line for the turn's env notice and the worker journal; undefined when every entry was exported. */
export function unexportedSummary(skipped: Unexported): string | undefined {
  const parts = ([["reserved", "reserved name"], ["invalid", "invalid name"], ["limit", "over limit"]] as const)
    .filter(([key]) => skipped[key] > 0).map(([key, label]) => `${label}: ${skipped[key]}`);
  const total = skipped.reserved + skipped.invalid + skipped.limit;
  return total ? `${total} ${total === 1 ? "entry was" : "entries were"} not exported as variables (${parts.join(", ")})` : undefined;
}

const CONTEXT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Team sharing (team-sharing-2-wire.md, Personal env files in shared mode): a
 * context's env files live only in ~/.zeros/contexts/<contextId>/env/ (0700,
 * files 0600), never in the shared checkout, and are erased when the context
 * retires. Their KEY=VALUE pairs load under the person's own variables. */
export class PersonalEnvironments {
  constructor(private readonly home: string) {}

  private root(contextId: string): string {
    if (!CONTEXT_ID.test(contextId)) throw new Error("Invalid execution context.");
    return join(this.home, ".zeros", "contexts", contextId);
  }

  async materialize(contextId: string, environment: Pick<CloudWorkspaceEnvironment, "variables" | "files">): Promise<{ directory: string; variables: Record<string, string>; unexported: Unexported }> {
    const root = this.root(contextId), directory = join(root, "env");
    const targets = environment.files.map(file => {
      const path = normalize(file.path);
      const target = join(directory, path);
      if (!path || isAbsolute(file.path) || relative(directory, target).split(sep)[0] === ".." || target === directory) throw new Error("Invalid personal environment file path.");
      return { target, content: file.content };
    });
    // Env-file contents are the repository's own; the control plane checks their paths and sizes, never the names
    // inside. Every file is written as-is; only names a process can take (not reserved: PATH, GIT_*, ZEROS_*, …)
    // also become variables, within the variable limits. The person's own variables (already checked) come first.
    const variables: Record<string, string> = { ...environment.variables }, skipped: Unexported = { reserved: 0, invalid: 0, limit: 0 };
    let count = Object.keys(variables).length, total = Object.entries(variables).reduce((sum, [name, value]) => sum + bytes(name) + bytes(value), 0);
    for (const file of environment.files) for (const [name, value] of Object.entries(parseEnv(file.content))) {
      if (value === undefined || Object.hasOwn(environment.variables, name)) continue;
      const reason = unexported(name, value);
      if (reason) { skipped[reason]++; continue; }
      const known = Object.hasOwn(variables, name), size = bytes(name) + bytes(value);
      if ((!known && count >= CLOUD_ENVIRONMENT_LIMITS.variables) ||
        total - (known ? bytes(name) + bytes(variables[name]!) : 0) + size > CLOUD_ENVIRONMENT_LIMITS.totalBytes) { skipped.limit++; continue; }
      total += size - (known ? bytes(name) + bytes(variables[name]!) : 0); if (!known) count++;
      variables[name] = value;
    }
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // recursive mkdir applies the mode only to directories it creates; the context's own two are always private.
      await chmod(root, 0o700); await chmod(directory, 0o700);
      for (const { target, content } of targets) {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600, flag: "w" });
        await chmod(target, 0o600);
      }
    } catch (error) {
      await this.erase(contextId).catch(() => {});
      throw error;
    }
    return { directory, variables, unexported: skipped };
  }

  /** Boot-clean (§7a): no person's files survive a boot. */
  async eraseAll(): Promise<void> { await rm(join(this.home, ".zeros", "contexts"), { recursive: true, force: true }); }

  /** After the context's processes are gone. */
  async erase(contextId: string): Promise<void> { await rm(this.root(contextId), { recursive: true, force: true }); }
}
