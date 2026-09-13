import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { DESIGN_MANIFEST_FILE, parseDesignManifest } from "./manifest";
import { sanitizeDesignDirectoryName } from "./directory-path";
import { stringify } from "smol-toml";
import { runGit } from "../git/git-exec";
import {
  DESIGN_DIRECTORY_REGISTRY_FILE,
  DESIGN_DIRECTORY_REGISTRY_FILES,
  designDirectoryRegistrySchema,
  designMetadataGitPaths,
  readDesignStorageFile,
  parseDesignDirectoryRegistry,
  readDesignDirectoryRegistry,
  readDesignRegistrySource,
  type DesignDirectoryRegistry,
} from "./metadata";

type IndexEnv = Record<string, string | undefined>;
const empty = (): DesignDirectoryRegistry => ({ version: 1, directories: {} });

/** Read the exact regular blob Git will use, rejecting unresolved index stages
 * and symlink registry entries. Null ref means an unborn HEAD. */
export async function designRegistryAtGitRef(
  cwd: string,
  ref: string | null,
  env?: IndexEnv,
): Promise<DesignDirectoryRegistry | null> {
  if (ref === null) return null;
  const registry =
    (await registrySnapshotAtGitRef(cwd, ref, env))?.registry ?? empty();
  const listing = await runGit(
    cwd,
    ref === ":" ? ["ls-files", "--stage", "-z"] : ["ls-tree", "-r", "-z", ref],
    { env, readOnly: true, maxBufferBytes: 64 * 1024 * 1024 },
  );
  const entries = listing.stdout.split("\0").filter(Boolean);
  const files = entries.map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const manifestIds = new Set<string>();
  for (const entry of entries) {
    const file = entry.slice(entry.indexOf("\t") + 1);
    const directory = path.posix.dirname(file);
    if (
      !file.endsWith(`/${DESIGN_MANIFEST_FILE}`) ||
      sanitizeDesignDirectoryName(directory) !== directory
    )
      continue;
    const match = /^(100644|100755) (?:blob )?([a-f0-9]{40,64})(?: 0)?\t/.exec(
      entry,
    );
    if (!match)
      throw new Error(
        "Resolve the Design manifest's Git conflict or file type before continuing.",
      );
    const blob = await runGit(cwd, ["cat-file", "blob", match[2]], {
      env,
      readOnly: true,
      maxBufferBytes: 16 * 1024 * 1024,
    });
    const manifest = parseDesignManifest(blob.stdout);
    if (!manifest) continue;
    const previous = registry.directories[manifest.id];
    if (
      manifestIds.has(manifest.id) ||
      (previous &&
        previous.path !== directory &&
        files.some((candidate) => candidate.startsWith(`${previous.path}/`)))
    )
      throw new Error("Multiple Design folders have the same ID in Git.");
    // git mv can finish before a legacy shared registry is cleaned up. When
    // its entire old source path is gone, the moved manifest owns that ID.
    manifestIds.add(manifest.id);
    registry.directories[manifest.id] = { path: directory };
  }
  return Object.keys(registry.directories).length
    ? designDirectoryRegistrySchema.parse(registry)
    : null;
}

async function registrySnapshotAtGitRef(
  cwd: string,
  ref: string | null,
  env?: IndexEnv,
): Promise<{
  file: string;
  registry: DesignDirectoryRegistry;
  source: string;
} | null> {
  if (ref === null) return null;
  const index = ref === ":";
  const { stdout } = await runGit(
    cwd,
    index
      ? [
          "ls-files",
          "--stage",
          "-z",
          "--",
          ...DESIGN_DIRECTORY_REGISTRY_FILES.map((file) => `:(literal)${file}`),
        ]
      : ["ls-tree", "-z", ref, "--", ...DESIGN_DIRECTORY_REGISTRY_FILES],
    { env, readOnly: true },
  );
  const entries = stdout.split("\0").filter(Boolean);
  if (!entries.length) return null;
  const match =
    /^(100644|100755) (?:blob )?([a-f0-9]{40,64})(?: 0)?\t(.+)$/.exec(
      entries[0],
    );
  if (entries.length !== 1 || !match)
    throw new Error(
      "Resolve the Design directory registry's Git conflict, duplicate locations, or file type before continuing.",
    );
  const blob = await runGit(cwd, ["cat-file", "blob", match[2]], {
    env,
    readOnly: true,
    maxBufferBytes: 16 * 1024 * 1024,
  });
  return {
    file: match[3],
    source: blob.stdout,
    registry: parseDesignDirectoryRegistry(blob.stdout),
  };
}

function projectDirectory(
  base: DesignDirectoryRegistry | null,
  next: DesignDirectoryRegistry | null,
  directory: string,
  extra?: DesignDirectoryRegistry | null,
): DesignDirectoryRegistry {
  const ids = new Set(
    [base, next, extra].flatMap((registry) =>
      Object.entries(registry?.directories ?? {})
        .filter(([, entry]) => entry.path === directory)
        .map(([id]) => id),
    ),
  );
  if (ids.size > 1)
    throw new Error(
      "The Design directory has conflicting IDs across Git snapshots.",
    );
  const projected = structuredClone(base ?? empty());
  for (const id of ids) {
    delete projected.directories[id];
    if (next?.directories[id]) projected.directories[id] = next.directories[id];
  }
  return designDirectoryRegistrySchema.parse(projected);
}

async function writeIndexRegistry(
  cwd: string,
  registry: DesignDirectoryRegistry,
  file: string,
  env?: IndexEnv,
  source?: string,
): Promise<void> {
  // A registry move is one logical change. Never leave a second registry in
  // the index, including when unstage restores an older branch's location.
  const remove = DESIGN_DIRECTORY_REGISTRY_FILES.filter(
    (candidate) =>
      !Object.keys(registry.directories).length || candidate !== file,
  );
  if (!Object.keys(registry.directories).length) {
    await runGit(cwd, ["update-index", "--force-remove", "--", ...remove], {
      env,
    });
    return;
  }
  const blob = await runGit(cwd, ["hash-object", "-w", "--stdin"], {
    input: source ?? stringify(registry) + "\n",
    env,
  });
  await runGit(
    cwd,
    [
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob.stdout.trim()},${file}`,
      "--force-remove",
      "--",
      ...remove,
    ],
    { env },
  );
}

/** Stage/unstage only this directory's registry entry. Unrelated staged and
 * working-tree entries remain byte-independent from this action. */
export async function stageDesignRegistry(
  cwd: string,
  directory: string,
  unstage = false,
): Promise<void> {
  const indexSnapshot = await registrySnapshotAtGitRef(cwd, ":");
  const index = indexSnapshot?.registry ?? null;
  const working = readDesignRegistrySource(cwd);
  let next =
    working.source === null
      ? null
      : parseDesignDirectoryRegistry(working.source);
  let file =
    working.source === null
      ? (indexSnapshot?.file ?? working.file)
      : working.file;
  let nextSource = working.source;
  if (unstage) {
    let head: string | null = null;
    try {
      head = (
        await runGit(cwd, ["rev-parse", "--verify", "HEAD"])
      ).stdout.trim();
    } catch {
      /* unborn */
    }
    const snapshot = await registrySnapshotAtGitRef(cwd, head);
    next = snapshot?.registry ?? null;
    nextSource = snapshot?.source ?? null;
    file = snapshot?.file ?? DESIGN_DIRECTORY_REGISTRY_FILE;
  }
  const projected = projectDirectory(
    index,
    next,
    directory,
    readDesignDirectoryRegistry(cwd),
  );
  if (!index && !Object.keys(projected.directories).length) return;
  const source = isDeepStrictEqual(projected, next)
    ? nextSource
    : isDeepStrictEqual(projected, index)
      ? indexSnapshot?.source
      : undefined;
  await writeIndexRegistry(
    cwd,
    projected,
    file,
    undefined,
    source ?? undefined,
  );
}

/** Select a registry entry inside the temporary commit index. The real index
 * retains other explicitly staged entries for their own Design checkpoints. */
export async function scopeDesignRegistryCommit(
  cwd: string,
  directory: string,
  head: string | null,
  env: IndexEnv,
): Promise<void> {
  const [base, staged] = await Promise.all([
    registrySnapshotAtGitRef(cwd, head),
    registrySnapshotAtGitRef(cwd, ":", env),
  ]);
  if (!base && !staged) return;
  const projected = projectDirectory(
    base?.registry ?? null,
    staged?.registry ?? null,
    directory,
    readDesignDirectoryRegistry(cwd),
  );
  const source = isDeepStrictEqual(projected, base?.registry)
    ? base?.source
    : isDeepStrictEqual(projected, staged?.registry)
      ? staged?.source
      : undefined;
  await writeIndexRegistry(
    cwd,
    projected,
    staged?.file ?? base!.file,
    env,
    source,
  );
}

/** Existing legacy index paths are needed even after migration deleted them.
 * Avoid passing nonexistent directories to git add/restore for new designs. */
export async function designMetadataIndexPaths(
  cwd: string,
  directory: string,
  includeHead = false,
): Promise<string[]> {
  const paths = designMetadataGitPaths(cwd, directory).filter(
    (file) =>
      !DESIGN_DIRECTORY_REGISTRY_FILES.some((registry) => registry === file),
  );
  if (!paths.length) return [];
  const listed = await runGit(
    cwd,
    [
      "ls-files",
      "--cached",
      "-z",
      "--",
      ...paths.map((file) => `:(literal)${file}`),
    ],
    { readOnly: true },
  );
  const found = new Set(listed.stdout.split("\0").filter(Boolean));
  if (includeHead) {
    let head: string | null = null;
    try {
      head = (
        await runGit(cwd, ["rev-parse", "--verify", "HEAD"], { readOnly: true })
      ).stdout.trim();
    } catch {
      /* unborn */
    }
    if (head) {
      const committed = await runGit(
        cwd,
        ["ls-tree", "-r", "-z", "--name-only", head, "--", ...paths],
        { readOnly: true },
      );
      for (const file of committed.stdout.split("\0").filter(Boolean))
        found.add(file);
    }
  }

  for (const file of paths) {
    if (file.endsWith(".md") && readDesignStorageFile(cwd, file) !== null)
      found.add(file);
    if (!file.endsWith(".md"))
      for (const name of ["metadata.json", "document.json"])
        if (readDesignStorageFile(cwd, `${file}/${name}`) !== null)
          found.add(`${file}/${name}`);
  }
  return [...found];
}
