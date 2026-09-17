import path from "node:path";
import { parseDesignManifest } from "../design/manifest";
import { stickyRecognizedDesignDirectories } from "../design/recognition-store";
import { designRegistryAtGitRef } from "../design/metadata-git";
import { runGit } from "./git-exec";
import { GitError } from "./errors";

/** Validate the captured index, never a later worktree draft. Missing companion
 * metadata is actionable; the engine must not silently stage additional files. */
export async function assertDesignCommitMetadata(
  cwd: string,
  env: NodeJS.ProcessEnv,
  selected: readonly string[],
): Promise<void> {
  const listing = await runGit(cwd, ["ls-files", "--stage", "-z"], {
    env,
    readOnly: true,
  });
  const entries = new Map(
    listing.stdout
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const separator = row.indexOf("\t");
        const [mode, oid] = row.slice(0, separator).split(" ");
        return [row.slice(separator + 1), { mode, oid }] as const;
      }),
  );
  const roots = new Set(await stickyRecognizedDesignDirectories(cwd));
  for (const file of entries.keys())
    if (path.posix.basename(file) === "design.toml") {
      const root = path.posix.dirname(file);
      if (selected.some((changed) => changed.startsWith(`${root}/`))) {
        const entry = entries.get(file)!;
        const { stdout } = await runGit(cwd, ["cat-file", "blob", entry.oid!], {
          env,
          readOnly: true,
        });
        if (parseDesignManifest(stdout)) roots.add(root);
      }
    }
  for (const root of roots) {
    if (!selected.some((file) => file.startsWith(`${root}/`))) continue;
    if (![...entries.keys()].some((file) => file.startsWith(`${root}/`)))
      continue; // Whole-folder deletion.
    const manifest = entries.get(`${root}/design.toml`);
    if (!manifest) {
      // Existing portable legacy documents remain committable until explicit
      // initialization migrates them. A new document must carry its manifest.
      if (entries.has(`${root}/.zeros-canvas.json`)) continue;
      const registry = await designRegistryAtGitRef(cwd, ":", env);
      if (
        Object.values(registry?.directories ?? {}).some(
          (entry) => entry.path === root,
        )
      )
        continue;
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `Stage ${root}/design.toml and rules.md with this Design folder before committing.`,
      });
    }
    const rules = entries.get(`${root}/rules.md`);
    const regular = (mode: string | undefined) =>
      mode === "100644" || mode === "100755";
    if (!regular(manifest.mode) || !rules || !regular(rules.mode))
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `The staged Design folder must include regular design.toml and rules.md files: ${root}`,
      });
    const { stdout } = await runGit(cwd, ["cat-file", "blob", manifest.oid!], {
      env,
      readOnly: true,
    });
    if (!parseDesignManifest(stdout))
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `The staged Design manifest is invalid: ${root}/design.toml`,
      });
  }
}
