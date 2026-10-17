import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface LocalCliInvocation {
  executable: string;
  args: string[];
}

export interface LocalCliRuntime {
  execPath: string;
  entry?: string;
  execArgv?: readonly string[];
  cwd?: string;
}

function sourceRuntimeArgs(args: readonly string[], cwd: string): string[] {
  const result: string[] = [];
  const resolver = createRequire(path.join(cwd, "package.json"));
  const loaders = ["--import", "--require", "-r", "--loader", "--experimental-loader", "--preload"];
  const resolve = (flag: string, value: string) => {
    if (isBuiltin(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
    const absolute = value.startsWith(".") || path.isAbsolute(value) ? path.resolve(cwd, value) : resolver.resolve(value);
    return ["--import", "--loader", "--experimental-loader"].includes(flag) ? pathToFileURL(absolute).href : absolute;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const equal = arg.indexOf("=");
    const flag = equal < 0 ? arg : arg.slice(0, equal);
    if (!loaders.includes(flag)) { result.push(arg); continue; }
    const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
    if (!value) throw new Error("Missing source-runtime loader argument.");
    if (equal < 0) result.push(flag, resolve(flag, value));
    else result.push(flag + "=" + resolve(flag, value));
  }
  return result;
}

/** Bun source execution still needs its entry script. Only a compiled engine
 * has no on-disk JS/TS entry (Bun may report its virtual $bunfs path instead). */
export function localCliInvocation(runtime: LocalCliRuntime = {
  execPath: process.execPath,
  entry: process.argv[1],
  execArgv: process.execArgv,
  cwd: process.cwd(),
}): LocalCliInvocation {
  const { execPath, entry, execArgv = [], cwd = process.cwd() } = runtime;
  const source = entry && entry !== execPath && /\.(?:[cm]?[jt]s|tsx)$/.test(entry) && !/(?:^|[/\\])\$bunfs(?:[/\\]|$)/.test(entry);
  return {
    executable: path.resolve(cwd, execPath),
    // A child runs in its own worktree. Resolve loaders against the engine's
    // cwd now, so a bare --import tsx does not search that child's node_modules.
    args: source ? [...sourceRuntimeArgs(execArgv, cwd), path.resolve(cwd, entry), "local"] : ["local"],
  };
}

function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("A CLI invocation cannot contain NUL.");
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function localCliLauncher(invocation: LocalCliInvocation): string {
  return [
    "#!/bin/sh",
    'if [ "${1-}" != local ]; then',
    "  printf '%s\\n' 'Only `zeros local …` is available here.' >&2",
    "  exit 2",
    "fi",
    "shift",
    "exec " + [invocation.executable, ...invocation.args].map(shellQuote).join(" ") + ' "$@"',
    "",
  ].join("\n");
}

export interface LocalCliBinOptions {
  dataDir: string;
  execPath?: string;
  entry?: string;
  execArgv?: readonly string[];
  cwd?: string;
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error("Local CLI directory must not be a symlink.");
  await chmod(directory, 0o700);
}

/** This returns a PATH directory, not a credential. Tokens stay in the admitted
 * execution's environment and never enter the launcher or its arguments. */
export async function ensureLocalCliBinDir(options: LocalCliBinOptions): Promise<string> {
  const runtime: LocalCliRuntime = {
    execPath: options.execPath ?? process.execPath,
    entry: options.entry ?? (options.execPath === undefined ? process.argv[1] : undefined),
    execArgv: options.execArgv ?? (options.execPath === undefined ? process.execArgv : []),
    cwd: options.cwd ?? process.cwd(),
  };
  const invocation = localCliInvocation(runtime);
  const packaged = path.join(path.dirname(invocation.executable), "bin");
  if (invocation.args.length === 1) {
    const launcher = path.join(packaged, "zeros");
    try {
      if ((await stat(launcher)).isFile()) {
        await access(launcher, constants.X_OK);
        return packaged;
      }
    } catch { /* A source or unpackaged engine uses its data directory. */ }
  }

  const root = path.resolve(options.dataDir, "local-cli");
  const directory = path.join(root, "bin");
  await privateDirectory(root);
  await privateDirectory(directory);
  const temporary = path.join(directory, ".zeros-" + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, localCliLauncher(invocation), { flag: "wx", mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, path.join(directory, "zeros"));
  } finally {
    await rm(temporary, { force: true });
  }
  return directory;
}
