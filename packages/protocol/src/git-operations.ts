export type GitValidationError = (message: string) => Error;
export type GitResetMode = "soft" | "mixed" | "hard";

export function validateGitReference(value: unknown, label: string, invalid: GitValidationError): string {
  if (typeof value !== "string" || value.length === 0) throw invalid(`${label}: must be a non-empty string`);
  if (value.startsWith("-")) throw invalid(`${label}: "${value}" starts with "-" (looks like a flag)`);
  if (value.includes("\0")) throw invalid(`${label}: contains a NUL byte`);
  return value;
}

export function requireGitPaths(paths: unknown, context: string, invalid: GitValidationError): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw invalid(`${context}: 'paths' must be a non-empty array of strings`);
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (typeof path !== "string" || path.length === 0) throw invalid(`${context}: paths[${i}] must be a non-empty string`);
    if (path.startsWith("-")) throw invalid(`${context}: paths[${i}] starts with "-" (looks like a flag)`);
  }
  return paths as string[];
}

export function validateGitReset(options: { mode: unknown; ref?: unknown; confirm?: unknown }, invalid: GitValidationError): { mode: GitResetMode; ref: string } {
  const { mode } = options;
  if (mode !== "soft" && mode !== "mixed" && mode !== "hard") throw invalid(`reset: invalid mode '${String(mode)}' (expected soft|mixed|hard)`);
  if (mode === "hard" && options.confirm !== true) throw invalid("reset --hard discards working-tree changes; pass confirm:true");
  return { mode, ref: validateGitReference(options.ref ?? "HEAD", "reset.ref", invalid) };
}

export const gitResetArgs = (mode: GitResetMode, target: string): string[] => ["reset", `--${mode}`, target];

export function gitRestoreArgs(options: { paths: unknown; source: unknown; staged?: unknown }, invalid: GitValidationError): string[] {
  const paths = requireGitPaths(options.paths, "restoreFrom", invalid);
  const source = validateGitReference(options.source, "restoreFrom.source", invalid);
  return ["restore", "--source", source, "--worktree", ...(options.staged !== false ? ["--staged"] : []), "--", ...paths.map(path => `:(literal)${path}`)];
}
