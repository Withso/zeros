import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { WorkspaceScope } from "./scope";

const MARKER = "<!-- Written by Zeros for this workspace's repositories; it is rewritten when the workspace starts. -->";
const NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * A workspace of several repositories starts its agents in the project folder,
 * which is not a checkout, so no agent would find each repository's own
 * instruction files from there by itself. This writes AGENTS.md and CLAUDE.md
 * into the project folder naming each repository's folder and the instruction
 * files it has (CLAUDE.md imports them with @), so they are read from the
 * start. A file there that Zeros did not write is never replaced.
 */
export async function writeWorkspaceInstructions(scope: WorkspaceScope): Promise<void> {
  if (!scope.several) return;
  const lines: string[] = [], imports: string[] = [];
  for (const entry of scope.repositories) {
    const folder = relative(scope.workspaceRoot, entry.checkoutPath);
    const own: string[] = [];
    for (const name of NAMES)
      if (await lstat(join(entry.checkoutPath, name)).then(stat => stat.isFile(), () => false)) own.push(`${folder}/${name}`);
    lines.push(`- \`${folder}/\` is ${entry.repository}, on branch \`${entry.branch}\` (based on \`${entry.baseBranch}\`).`
      + (own.length ? ` Read ${own.map(path => `\`${path}\``).join(" and ")} before working in it.` : ""));
    imports.push(...own.filter(path => basename(path) === "CLAUDE.md" || !own.includes(`${folder}/CLAUDE.md`)).map(path => `@${path}`));
  }
  const body = [MARKER, "", "# This workspace's repositories", "",
    "This folder holds several Git repositories, each in its own folder. Run Git inside the repository you are changing;",
    "each one follows its own instructions.", "", ...lines, ""].join("\n");
  for (const name of NAMES) {
    const path = join(scope.workspaceRoot, name);
    const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : undefined);
    if (existing === undefined || (existing !== null && !existing.startsWith(MARKER))) continue;
    const text = name === "CLAUDE.md" && imports.length ? `${body}\n${imports.join("\n")}\n` : body;
    const temporary = `${path}.zeros-${process.pid}`;
    await writeFile(temporary, text, { mode: 0o644 });
    await rename(temporary, path);
  }
}
