import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

const START = "# Zeros Design metadata (managed by Zeros)";
const END = "# End Zeros Design metadata";

/** Replace the previous shared-metadata exception with private local storage.
 * Design manifests now travel inside their source folders. */
export function designGitignoreSource(
  source: string | null,
  directories: string[] = [],
): string {
  const text = source ?? "";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let start = -1,
    end = -1,
    offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const value = line.replace(/\r?\n$/, "");
    if (value === START) {
      if (start !== -1)
        throw new Error(
          "The managed Zeros Design Git ignore block is duplicated.",
        );
      start = offset;
    }
    if (value === END) {
      if (end !== -1 || start === -1)
        throw new Error(
          "The managed Zeros Design Git ignore block is incomplete.",
        );
      end = offset + line.length;
    }
    offset += line.length;
  }
  if ((start === -1) !== (end === -1))
    throw new Error("The managed Zeros Design Git ignore block is incomplete.");
  const before = start === -1 ? text : text.slice(0, start) + text.slice(end);
  const block = [
    START,
    "/.zeros/",
    ...[
      ...new Set(
        directories.flatMap((directory) => {
          const escaped = (value: string) =>
            value.replace(/[\\*?!#[\] ]/g, "\\$&");
          return [
            `!/${escaped(directory)}/`,
            `!/${escaped(directory)}/design.toml`,
            `!/${escaped(directory)}/rules.md`,
          ];
        }),
      ),
    ].sort(),
    END,
    "",
  ].join(newline);
  return `${before}${before && !before.endsWith("\n") ? newline : ""}${block}`;
}

const visibilityChecks = new Map<string, string>();

/** Root rules override global/local excludes, but a nested .gitignore has
 * higher priority. Check with Git itself and invalidate when an ancestor rule
 * changes; warm document saves do not spawn a Git process. */
export function assertDesignFilesNotIgnored(
  workspace: string,
  files: string[],
): void {
  if (!existsSync(path.join(workspace, ".git"))) return;
  const ignores = new Set<string>();
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (directory !== ".") {
      ignores.add(`${directory}/.gitignore`);
      directory = path.posix.dirname(directory);
    }
  }
  ignores.add(".gitignore");
  const signature = [...ignores]
    .map((file) => {
      try {
        const stat = lstatSync(path.join(workspace, file));
        return `${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return `${file}:missing`;
        throw error;
      }
    })
    .join("\0");
  const key = `${workspace}\0${files.join("\0")}`;
  if (visibilityChecks.get(key) === signature) return;
  let ignored: string;
  try {
    ignored = execFileSync(
      "git",
      ["check-ignore", "--no-index", "-z", "--stdin"],
      {
        cwd: workspace,
        input: files.join("\0") + "\0",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
    ignored = "";
  }
  if (ignored)
    throw new Error(
      `Design metadata is still ignored by a conflicting .gitignore: ${ignored.split("\0").filter(Boolean).join(", ")}. Remove the conflicting parent or nested rule before editing Design.`,
    );
  visibilityChecks.delete(key);
  visibilityChecks.set(key, signature);
  if (visibilityChecks.size > 512)
    visibilityChecks.delete(visibilityChecks.keys().next().value!);
}
