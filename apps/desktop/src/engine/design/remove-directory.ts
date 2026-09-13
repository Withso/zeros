import path from "node:path";
import { workspaceViewMode } from "../git/types";
import { listWorkspaces } from "../git/state";
import { refExists } from "../git/default-branch";
import { runGit } from "../git/git-exec";
import { withWorkspaceGitMutation } from "../git/mutation-lock";
import {
  assertGitCheckpointReady,
  commitDesignMetadataRemoval,
} from "../git/ops";
import {
  opSettingsPreviewWrite,
  opSettingsResolve,
  opSettingsWrite,
} from "../settings/ops";
import {
  prepareDesignMetadataRemoval,
  DESIGN_DIRECTORY_REGISTRY_FILES,
} from "./metadata";
import {
  designDirectoryNameFor,
  primeDesignDirectoryName,
} from "./directory-registry";
import { forgetRecognizedDesignDirectory } from "./recognition-store";

/** Trusted desktop Settings operation; the engine hands off Design actors first. */
export async function removeDesignDirectory(opts: {
  repoRoot: string;
  directory: string;
}): Promise<void> {
  return withWorkspaceGitMutation(opts.repoRoot, async () => {
    const { repoRoot, directory } = opts;
    if (
      listWorkspaces({ archived: false }).some(
        (ws) =>
          workspaceViewMode(ws) === "design" &&
          path.resolve(ws.repoRoot) === path.resolve(repoRoot),
      )
    )
      throw new Error(
        "Design workspaces are still open on this repo. Switch them to Code mode before removing a Design registration.",
      );
    await assertGitCheckpointReady(repoRoot);
    const removal = prepareDesignMetadataRemoval(repoRoot, directory);
    const selection = opSettingsResolve(repoRoot).effective.design as
      | { directory?: string; directory_id?: string }
      | undefined;
    const clearSelection =
      selection?.directory === directory ||
      (!!removal.id && selection?.directory_id === removal.id);
    const patch = { design: { directory_id: null, directory: null } };
    if (clearSelection) opSettingsPreviewWrite("repo-local", patch, repoRoot);
    // A shared legacy registry can also carry other folders' edits. Never commit those.
    const shared = removal.changes.filter((change) =>
      DESIGN_DIRECTORY_REGISTRY_FILES.some((file) => file === change.file),
    );
    if (shared.length) {
      const status = await runGit(repoRoot, [
        "status",
        "--porcelain",
        "--",
        ...shared.map((change) => `:(literal)${change.file}`),
      ]);
      if (status.stdout.trim())
        throw new Error(
          "Commit the legacy Design registry changes before removing a registration.",
        );
    }
    const tracked = new Set(
      (await runGit(repoRoot, ["ls-files", "-z"])).stdout.split("\0"),
    );
    if (await refExists(repoRoot, "HEAD")) {
      const head = await runGit(repoRoot, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        "HEAD",
      ]);
      for (const file of head.stdout.split("\0")) tracked.add(file);
    }
    removal.apply();
    const files = removal.changes
      .map((change) => change.file)
      .filter((file) => tracked.has(file));
    if (files.length) {
      try {
        await commitDesignMetadataRemoval(repoRoot, directory, files);
      } catch (error) {
        removal.rollback();
        throw error;
      }
      const removed = removal.changes
        .filter(
          (change) => change.after === null && files.includes(change.file),
        )
        .map((change) => change.file);
      const retained = files.filter((file) => !removed.includes(file));
      if (removed.length)
        await runGit(repoRoot, [
          "update-index",
          "--force-remove",
          "--ignore-missing",
          "--",
          ...removed,
        ]);
      if (retained.length)
        await runGit(repoRoot, [
          "add",
          "-f",
          "--",
          ...retained.map((file) => `:(literal)${file}`),
        ]);
    }
    if (clearSelection) opSettingsWrite("repo-local", patch, repoRoot);
    await forgetRecognizedDesignDirectory(repoRoot, directory);
    if (designDirectoryNameFor(repoRoot) === directory)
      primeDesignDirectoryName(repoRoot, null);
  });
}
