import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { runGit } from "../git/git-exec";
import { withWorkspaceGitMutation } from "../git/mutation-lock";
import { opSettingsPreviewWrite, opSettingsWrite } from "../settings/ops";
import {
  assertSafeProspectiveDesignDirectory,
  discoverDesignDirectories,
} from "./directory";
import { primeDesignDirectoryName } from "./directory-registry";
import { sanitizeDesignDirectoryName } from "./directory-path";
import { inspectDesignFilesForAdoption } from "./document";
import { parseDesignManifest } from "./manifest";
import {
  assertSafeDesignStoragePath,
  commitDesignMetadata,
  designDirectoryEntry,
  legacyDesignDirectoryId,
  designDocumentMetadataPath,
  parseDesignDirectoryRegistry,
  readDesignRegistrySource,
  readDesignStorageFile,
  recoverWorkspaceDesignMetadata,
  DESIGN_DIRECTORY_REGISTRY_FILES,
} from "./metadata";

export interface DesignFolderPreview {
  directory: string;
  metadataSource: "folder" | "git" | "rebuild";
  frameCount: number;
  revision: string;
}

async function gitFile(
  root: string,
  file: string,
  ref: string,
): Promise<string | null> {
  const listing = await runGit(
    root,
    ref === ":"
      ? ["ls-files", "--stage", "-z", "--", `:(literal)${file}`]
      : ["ls-tree", "-z", ref, "--", file],
    { readOnly: true },
  );
  const entries = listing.stdout.split("\0").filter(Boolean);
  if (!entries.length) return null;
  const match = /^(100644|100755) (?:blob )?([a-f0-9]{40,64})(?: 0)?\t/.exec(
    entries[0],
  );
  if (!match || entries.length !== 1)
    throw new Error(
      "Resolve the Design metadata's Git conflict or file type before choosing this folder.",
    );
  return (
    await runGit(root, ["cat-file", "blob", match[2]], {
      readOnly: true,
      maxBufferBytes: 16 * 1024 * 1024,
    })
  ).stdout;
}

function selectedDirectory(root: string, selected: string): string | null {
  if (!path.isAbsolute(selected)) return sanitizeDesignDirectoryName(selected);
  const relative = (base: string) =>
    sanitizeDesignDirectoryName(
      path.relative(base, selected).split(path.sep).join("/"),
    );
  const direct = relative(root);
  if (direct) return direct;
  // A native picker may use /private/var while the registered root uses /var,
  // or resolve a registered root alias. Match that root's physical identity;
  // the normal validator still rejects any linked segment BELOW that root.
  const physicalRoot = realpathSync(root);
  let ancestor = path.dirname(selected);
  while (true) {
    try {
      if (realpathSync(ancestor) === physicalRoot) return relative(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return null;
    ancestor = parent;
  }
}

async function inspectFolder(root: string, selected: string) {
  const directory = selectedDirectory(root, selected);
  if (!directory)
    throw new Error(
      "Choose a Design folder inside this repository, below its root.",
    );
  await assertSafeProspectiveDesignDirectory(root, directory);
  if (!lstatSync(path.join(root, directory)).isDirectory())
    throw new Error("Choose an existing directory.");
  let ancestor = directory;
  while (ancestor !== ".") {
    if (existsSync(path.join(root, ancestor, ".git")))
      throw new Error(
        "Choose a folder in this repository, outside nested repositories.",
      );
    ancestor = path.posix.dirname(ancestor);
  }
  const pending = [path.join(root, directory)];
  let visited = 0;
  while (pending.length) {
    if (++visited > 20_000)
      throw new Error("The chosen folder exceeds the Design discovery limit.");
    const folder = pending.pop()!;
    const entries = await readdir(folder, { withFileTypes: true });
    if (entries.some((entry) => entry.name === ".git"))
      throw new Error(
        "Choose a Design folder that does not contain a nested repository.",
      );
    for (const entry of entries)
      if (entry.isDirectory()) pending.push(path.join(folder, entry.name));
  }
  const recognized = await discoverDesignDirectories(root);
  const portable = (value: string) => value.normalize("NFC").toLowerCase();
  for (const other of recognized) {
    if (
      other !== directory &&
      (portable(other) === portable(directory) ||
        portable(other).startsWith(portable(directory) + "/") ||
        portable(directory).startsWith(portable(other) + "/"))
    )
      throw new Error("This folder overlaps another Design directory.");
  }
  const file = `${directory}/design.toml`;
  assertSafeDesignStoragePath(root, file);
  const source = readDesignStorageFile(root, file);
  const manifest = source === null ? null : parseDesignManifest(source);
  if (source !== null && !manifest)
    throw new Error(
      "This folder already has a design.toml belonging to another application.",
    );
  let id = manifest?.id ?? designDirectoryEntry(root, directory)?.id;
  let document = manifest?.document;
  let expectedFile = file;
  let expectedSource = source;
  let metadataSource: DesignFolderPreview["metadataSource"] = "folder";
  if (!document) {
    const previousPath = path
      .relative(root, designDocumentMetadataPath(root, directory))
      .split(path.sep)
      .join("/");
    const legacy = readDesignStorageFile(root, previousPath);
    if (legacy !== null) {
      document = JSON.parse(legacy) as Record<string, unknown>;
      expectedFile = previousPath;
      expectedSource = legacy;
    }
  }
  if (!document && existsSync(path.join(root, ".git"))) {
    let head: string | null = null;
    try {
      head = (
        await runGit(root, ["rev-parse", "--verify", "HEAD"], {
          readOnly: true,
        })
      ).stdout.trim();
    } catch {
      /* unborn */
    }
    for (const ref of [":", ...(head ? [head] : [])]) {
      const saved = await gitFile(root, file, ref);
      if (saved !== null) {
        const recovered = parseDesignManifest(saved);
        if (!recovered)
          throw new Error(
            "Git contains a different application's design.toml at this path.",
          );
        if (id && id !== recovered.id)
          throw new Error("Saved Design metadata has a conflicting ID.");
        id = recovered.id;
        document = recovered.document;
        metadataSource = "git";
        break;
      }
      const registries = (
        await Promise.all(
          DESIGN_DIRECTORY_REGISTRY_FILES.map(async (location) => ({
            location,
            source: await gitFile(root, location, ref),
          })),
        )
      ).filter((entry) => entry.source !== null);
      if (registries.length > 1)
        throw new Error(
          "Resolve the competing saved Design registries before recovery.",
        );
      const registry = registries[0]
        ? parseDesignDirectoryRegistry(registries[0].source!)
        : null;
      const entry = Object.entries(registry?.directories ?? {}).find(
        ([, value]) => value.path === directory,
      );
      const candidates = entry
        ? [
            `.zeros/design/${entry[0]}/metadata.json`,
            `.zeros/design/${entry[0]}/document.json`,
          ]
        : [`${directory}/.zeros-canvas.json`];
      const sources = (
        await Promise.all(
          candidates.map((candidate) => gitFile(root, candidate, ref)),
        )
      ).filter((value) => value !== null);
      if (sources.length > 1)
        throw new Error(
          "Resolve the competing saved Design metadata before recovery.",
        );
      if (sources[0]) {
        id = entry?.[0] ?? id ?? legacyDesignDirectoryId(directory);
        document = JSON.parse(sources[0]) as Record<string, unknown>;
        metadataSource = "git";
        break;
      }
    }
  }
  if (!document) {
    metadataSource = "rebuild";
    document = await inspectDesignFilesForAdoption(root, directory);
  }
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        directory,
        id,
        document,
        source,
        registry: readDesignRegistrySource(root),
      }),
    )
    .digest("hex");
  const frames =
    document.frames && typeof document.frames === "object"
      ? Object.keys(document.frames).length
      : 0;
  const registry = readDesignRegistrySource(root);
  return {
    preview: { directory, metadataSource, frameCount: frames, revision },
    id,
    document,
    expected: {
      file: expectedFile,
      source: expectedSource,
      registry: registry.source,
      registryFile: registry.file,
    },
  };
}

export async function previewExistingDesignDirectory(
  root: string,
  folder: string,
): Promise<DesignFolderPreview> {
  return (await inspectFolder(root, folder)).preview;
}

/** Explicit Settings action. Discovery alone never claims arbitrary source. */
export async function adoptExistingDesignDirectory(
  root: string,
  folder: string,
  revision: string,
  canSelect: (id: string) => boolean = () => true,
): Promise<DesignFolderPreview & { selected: boolean }> {
  return withWorkspaceGitMutation(root, async () => {
    recoverWorkspaceDesignMetadata(root);
    const inspected = await inspectFolder(root, folder);
    if (inspected.preview.revision !== revision)
      throw new Error(
        "The folder changed since the preview. Choose it again before continuing.",
      );
    const directory = inspected.preview.directory;
    // Validate the private settings file before registering anything. Selecting
    // by path here is a preview only; the persisted selection below uses the ID.
    opSettingsPreviewWrite(
      "repo-local",
      { design: { directory, directory_id: null } },
      root,
    );
    commitDesignMetadata(
      root,
      directory,
      JSON.stringify(inspected.document),
      [],
      inspected.expected,
      inspected.id,
    );
    const entry = designDirectoryEntry(root, directory)!;
    const selected = canSelect(entry.id);
    if (selected) {
      opSettingsWrite(
        "repo-local",
        { design: { directory: null, directory_id: entry.id } },
        root,
      );
      primeDesignDirectoryName(root, directory);
    }
    return { ...inspected.preview, selected };
  });
}
