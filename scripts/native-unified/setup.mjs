// Pure decisions for --build and --cleanup, kept apart from the commands that act on them so tests reach them
// without a real worktree or an Electron download.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Whether pnpm's Electron package holds its binary, by the same test as Electron's own install.js (isInstalled):
 * dist/version is this package's version, path.txt names the executable, and that executable exists. A
 * `pnpm install --prefer-offline` that skips the package's postinstall leaves none of them.
 */
export function electronInstall(packageDir) {
  let version = null;
  try { version = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")).version ?? null; } catch { /* no package */ }
  if (!version) return { installed: false, version: null, reason: "no electron package: run pnpm install first" };
  const read = (file) => { try { return readFileSync(path.join(packageDir, file), "utf8"); } catch { return null; } };
  const distVersion = read(path.join("dist", "version"))?.trim().replace(/^v/, "");
  const executable = read("path.txt");
  const installed = distVersion === version && Boolean(executable) && existsSync(path.join(packageDir, "dist", executable));
  return { installed, version, reason: installed ? null : distVersion && distVersion !== version ? `dist holds ${distVersion}` : "no dist" };
}

/**
 * How --cleanup removes the worktree it runs from, or null to leave the checkout alone. Only a linked worktree
 * (its git dir is not the common one) whose real top level is under the temp directory qualifies: never a
 * person's checkout. Both commands run from the main checkout, because the first deletes the folder the script
 * (and its default cwd) lives in, and spawning with a deleted cwd fails with ENOENT.
 */
export function worktreeRemoval({ repo, gitDir, common, realTop, tmp }) {
  if (!gitDir || !common || !realTop || !tmp) return null;
  if (path.resolve(repo, gitDir) === path.resolve(repo, common)) return null;
  if (!realTop.startsWith(`${tmp}${path.sep}`)) return null;
  const main = path.dirname(path.resolve(repo, common));
  return {
    main,
    commands: [
      { args: ["-C", main, "worktree", "remove", "--force", realTop], cwd: main },
      { args: ["-C", main, "worktree", "prune"], cwd: main },
    ],
  };
}
