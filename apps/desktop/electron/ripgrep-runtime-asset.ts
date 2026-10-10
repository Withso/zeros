import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

interface RipgrepRuntimeOptions {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly repoRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}
interface RipgrepRuntimeDependencies {
  readonly exists?: (file: string) => boolean;
  readonly resolveModule?: (specifier: string, anchor?: string) => string;
}

/** Electron resolves the pinned product search binary before handing its path
 * to the compiled engine. Legacy courier names remain readers for old launchers. */
export function resolveProductRipgrepPath(
  options: RipgrepRuntimeOptions,
  dependencies: RipgrepRuntimeDependencies = {},
): string | null {
  const exists = dependencies.exists ?? existsSync;
  const explicit = options.env.ZEROS_RIPGREP_PATH?.trim() || options.env.ZEROS_ZSR_RIPGREP_PATH?.trim();
  if (explicit) return exists(explicit) ? explicit : null;
  const binary = options.platform === "win32" ? "rg.exe" : "rg";
  const staged = options.packaged
    ? path.join(options.resourcesPath, binary)
    : path.join(options.repoRoot, "binaries", binary);
  if (exists(staged)) return staged;
  if (options.packaged) return null;
  const resolveModule = dependencies.resolveModule ?? ((specifier: string, anchor?: string) =>
    createRequire(anchor ?? path.join(options.repoRoot, "package.json")).resolve(specifier));
  try {
    const entry = resolveModule("@vscode/ripgrep", undefined);
    const resolved = resolveModule(`@vscode/ripgrep-${options.platform}-${options.arch}/bin/${binary}`, entry);
    return exists(resolved) ? resolved : null;
  } catch {
    return null;
  }
}
