import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { getLoginShellPath } from "../src/engine/agents/adapters/shared/login-shell-path";

function restoreDevNodePath(env: NodeJS.ProcessEnv): void {
  const executable = env.ZEROS_DEV_NODE_EXECUTABLE;
  if (
    !executable ||
    !path.isAbsolute(executable) ||
    /[\0\r\n]/.test(executable) ||
    !/^node(?:\.exe)?$/i.test(path.basename(executable))
  )
    return;
  const directory = path.dirname(executable);
  if (directory.includes(path.delimiter)) return;
  try {
    if (!statSync(executable).isFile()) return;
    accessSync(executable, constants.X_OK);
  } catch {
    return;
  }
  env.PATH = [
    directory,
    ...(env.PATH ?? "")
      .split(path.delimiter)
      .filter((entry) => entry !== directory),
  ].join(path.delimiter);
}

/** Load user-installed CLIs before the engine inherits the desktop environment. */
export async function hydrateShellPath(options: {
  development: boolean;
  env?: NodeJS.ProcessEnv;
  loadShellPath?: () => void | Promise<void>;
}): Promise<void> {
  const env = options.env ?? process.env;
  try {
    if (options.loadShellPath) await options.loadShellPath();
    else if (env.ZEROS_LOCAL_DEVELOPMENT === "1") env.PATH = await getLoginShellPath();
    else {
      // fix-path is ESM-only; Electron main is bundled as CommonJS.
      const mod = (await import("fix-path")) as { default: () => void };
      mod.default();
    }
  } catch (err) {
    console.warn(
      `[Zeros] fix-path failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Login-shell initialization can replace the working Node selected by the
    // Dev launcher. Preserve that exact toolchain for engine/provider children,
    // without hiding user CLI directories or changing packaged app resolution.
    if (options.development) restoreDevNodePath(env);
  }
  console.log(
    `[Zeros] shell PATH hydrated (${(env.PATH ?? "").split(path.delimiter).length} entries)`,
  );
}
