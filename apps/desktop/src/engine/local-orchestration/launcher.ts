import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { engineCliInvocation, type EngineCliInvocation, type EngineCliRuntime } from "../cli-invocation";

export type LocalCliInvocation = EngineCliInvocation;
export type LocalCliRuntime = EngineCliRuntime;

export function localCliInvocation(runtime?: LocalCliRuntime): LocalCliInvocation {
  return engineCliInvocation("local", runtime);
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
