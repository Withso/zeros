import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface EngineCliInvocation {
  executable: string;
  args: string[];
}

export interface EngineCliRuntime {
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
export function engineCliInvocation(command: "local" | "design", runtime: EngineCliRuntime = {
  execPath: process.execPath,
  entry: process.argv[1],
  execArgv: process.execArgv,
  cwd: process.cwd(),
}): EngineCliInvocation {
  const { execPath, entry, execArgv = [], cwd = process.cwd() } = runtime;
  const source = entry && entry !== execPath && /\.(?:[cm]?[jt]s|tsx)$/.test(entry) && !/(?:^|[/\\])\$bunfs(?:[/\\]|$)/.test(entry);
  return {
    executable: path.resolve(cwd, execPath),
    // A child runs in its own worktree. Resolve loaders against the engine's
    // cwd now, so a bare --import tsx does not search that child's node_modules.
    args: source ? [...sourceRuntimeArgs(execArgv, cwd), path.resolve(cwd, entry), command] : [command],
  };
}
