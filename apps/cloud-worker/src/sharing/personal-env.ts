import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { parseEnv } from "node:util";
import type { CloudWorkspaceEnvironment } from "@zeros/protocol/cloud-v2-relay";

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

  async materialize(contextId: string, environment: Pick<CloudWorkspaceEnvironment, "variables" | "files">): Promise<{ directory: string; variables: Record<string, string> }> {
    const root = this.root(contextId), directory = join(root, "env");
    const targets = environment.files.map(file => {
      const path = normalize(file.path);
      const target = join(directory, path);
      if (!path || isAbsolute(file.path) || relative(directory, target).split(sep)[0] === ".." || target === directory) throw new Error("Invalid personal environment file path.");
      return { target, content: file.content };
    });
    const variables: Record<string, string> = {};
    for (const file of environment.files) Object.assign(variables, parseEnv(file.content));
    Object.assign(variables, environment.variables);
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
    return { directory, variables };
  }

  /** Boot-clean (§7a): no person's files survive a boot. */
  async eraseAll(): Promise<void> { await rm(join(this.home, ".zeros", "contexts"), { recursive: true, force: true }); }

  /** After the context's processes are gone. */
  async erase(contextId: string): Promise<void> { await rm(this.root(contextId), { recursive: true, force: true }); }
}
