import { cp, lstat, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { HarnessFailure } from "./assertions";

const inside = (root: string, value: string) => {
  const relative = path.relative(root, value);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const check: (value: unknown) => asserts value = value => { if (!value) throw new HarnessFailure("fixture_contract_invalid"); };
const namePattern = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i;
type Metadata = { name: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  os?: string[]; cpu?: string[] };

/** SOURCE-mode fixture schemas import the standalone CP assembler, whose
 * schema graph loads pg, Hono request timing and its own Zod3. These are fixture-only dependencies;
 * the shipped engine dependency/bundle closure is unchanged. Preserve every
 * owner-relative alias and physical version in the private input copy. */
export async function stageSourceFixtureDependencies(sourceRoot: string, privateRoot: string) {
  const source = await realpath(sourceRoot), destination = await realpath(privateRoot);
  check(source !== destination && !inside(destination, source));
  const owner = await realpath(path.join(source, "apps/control-plane"));
  check(inside(source, owner));
  const visited = new Set<string>();
  const mapped = (value: string) => { check(inside(source, value)); return path.join(destination, path.relative(source, value)); };
  async function privatePath(value: string): Promise<void> {
    check(inside(destination, value));
    let current = value;
    for (;;) {
      try { check(inside(destination, await realpath(current))); return; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        check(current !== destination); current = path.dirname(current);
      }
    }
  }
  const allows = (values: string[] | undefined, target: string) => !values?.length ||
    (!values.includes(`!${target}`) && (!values.some(value => !value.startsWith("!")) || values.includes(target)));
  async function edge(name: string, owner: string, optional = false): Promise<void> {
    check(name.length <= 128 && namePattern.test(name) && inside(source, owner));
    const require = createRequire(path.join(owner, "package.json"));
    let candidate: string | undefined, physical: string | undefined;
    for (const directory of require.resolve.paths(`${name}/package.json`) ?? []) {
      const value = path.join(directory, name);
      try { await lstat(path.join(value, "package.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      check(inside(source, value)); candidate = value; physical = await realpath(value); check(inside(source, physical)); break;
    }
    if (!candidate || !physical) { check(optional); return; }
    const metadata = JSON.parse(await readFile(path.join(physical, "package.json"), "utf8")) as Metadata;
    check(metadata && metadata.name === name);
    if (!allows(metadata.os, "linux") || !allows(metadata.cpu, "x64")) { check(optional); return; }
    const target = mapped(physical), alias = mapped(candidate);
    await privatePath(target); await privatePath(alias);
    if (!visited.has(physical)) {
      check(visited.size < 1024); visited.add(physical);
      let exists = false;
      try { await lstat(target); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!exists) {
        await mkdir(path.dirname(target), { recursive: true });
        // Node's default cp rewrites relative symlinks to the source's absolute
        // path. Preserve the package owner's aliases inside the copied tree.
        await cp(physical, target, { recursive: true, dereference: false, verbatimSymlinks: true });
      }
      const dependencies = new Map<string, boolean>();
      for (const name of Object.keys(metadata.peerDependencies ?? {})) dependencies.set(name, metadata.peerDependenciesMeta?.[name]?.optional === true);
      for (const name of Object.keys(metadata.dependencies ?? {})) dependencies.set(name, false);
      for (const name of Object.keys(metadata.optionalDependencies ?? {})) dependencies.set(name, true);
      check(dependencies.size <= 256);
      for (const [name, optional] of [...dependencies].sort(([a], [b]) => a.localeCompare(b))) await edge(name, physical, optional);
    }
    if (alias !== target) {
      await mkdir(path.dirname(alias), { recursive: true });
      let exists = false;
      try { await lstat(alias); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (exists) check(await realpath(alias) === await realpath(target));
      else await symlink(path.relative(path.dirname(alias), target), alias);
    }
  }
  await edge("pg", owner); await edge("zod", owner); await edge("hono", owner);
  return { packageCount: visited.size };
}
