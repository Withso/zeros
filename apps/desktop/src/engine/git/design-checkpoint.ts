import path from "node:path";
import { parseDesignManifest } from "../design/manifest";
import { decodeCanvasFile } from "../design/canvas-file";
import { resolveDesignManifestLayout, type DesignDirectoryLayout } from "../design/layout";
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
        const [mode, oid, stage] = row.slice(0, separator).split(" ");
        return [row.slice(separator + 1), { mode, oid, stage }] as const;
      }),
  );
  const roots = new Set(await stickyRecognizedDesignDirectories(cwd));
  const layouts = new Map<string, DesignDirectoryLayout>();
  const regular = (entry: { mode?: string; stage?: string } | undefined) =>
    !!entry && (entry.mode === "100644" || entry.mode === "100755") && entry.stage === "0";
  for (const file of entries.keys())
    if (path.posix.basename(file) === "design.toml") {
      const parent = path.posix.dirname(file);
      const candidate = path.posix.basename(parent) === "meta" ? path.posix.dirname(parent) : parent;
      if (selected.some((changed) => changed.startsWith(`${candidate}/`))) {
        const entry = entries.get(file)!;
        const { stdout } = await runGit(cwd, ["cat-file", "blob", entry.oid!], {
          env,
          readOnly: true,
          maxBufferBytes: 16 * 1024 * 1024,
        });
        const manifest = parseDesignManifest(stdout);
        if (!manifest) continue;
        const layout = resolveDesignManifestLayout(file, manifest);
        if (layouts.has(layout.directory))
          throw new GitError({ code: "VALIDATION_FAILED", message: `Competing staged root and meta Design registrations exist: ${layout.directory}` });
        layouts.set(layout.directory, layout);
        roots.add(layout.directory);
      }
    }
  for (const root of roots) {
    if (!selected.some((file) => file.startsWith(`${root}/`))) continue;
    if (![...entries.keys()].some((file) => file.startsWith(`${root}/`)))
      continue; // Whole-folder deletion.
    const layout = layouts.get(root);
    if (!layout) {
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
        message: `Stage the Design registration (${root}/meta/design.toml or the legacy ${root}/design.toml) and ${root}/rules.md with this Design folder before committing.`,
      });
    }
    const manifest = entries.get(layout.manifestFile)!;
    const rules = entries.get(layout.rulesFile);
    if (!regular(manifest) || !regular(rules))
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `The staged Design folder must include regular ${layout.manifestFile} and ${layout.rulesFile} files.`,
      });
    const { stdout } = await runGit(cwd, ["cat-file", "blob", manifest.oid!], {
      env,
      readOnly: true,
    });
    const registration = parseDesignManifest(stdout);
    if (!registration)
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `The staged Design manifest is invalid: ${layout.manifestFile}`,
      });
    if (registration.canvas) {
      const canvas = entries.get(layout.documentFile);
      if (!regular(canvas))
        throw new GitError({ code: "VALIDATION_FAILED", message: `Stage ${layout.documentFile} with this Design folder before committing.` });
      const { stdout: source } = await runGit(cwd, ["cat-file", "blob", canvas!.oid!], { env, readOnly: true, maxBufferBytes: 16 * 1024 * 1024 });
      let document: Record<string, unknown>;
      try {
        if (Buffer.byteLength(source) > 16 * 1024 * 1024) throw new Error("Canvas is too large.");
        document = decodeCanvasFile(source, { version: layout.canvasVersion });
      } catch {
        throw new GitError({ code: "VALIDATION_FAILED", message: `The staged Design canvas is invalid: ${layout.documentFile}` });
      }
      for (const file of Object.keys(document.frames as Record<string, unknown>)) {
        if (!regular(entries.get(`${root}/${file}`)))
          throw new GitError({ code: "VALIDATION_FAILED", message: `The staged canvas references a missing or unsafe frame source: ${root}/${file}` });
      }
    }
  }
}
