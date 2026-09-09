import { stringify } from "smol-toml";
import { runGit } from "../git/git-exec";
import {
  DESIGN_DIRECTORY_REGISTRY_FILE,
  designDirectoryRegistrySchema,
  parseDesignDirectoryRegistry,
  readDesignDirectoryRegistry,
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
  const index = ref === ":";
  const { stdout } = await runGit(
    cwd,
    index
      ? [
          "ls-files",
          "--stage",
          "-z",
          "--",
          `:(literal)${DESIGN_DIRECTORY_REGISTRY_FILE}`,
        ]
      : ["ls-tree", "-z", ref, "--", DESIGN_DIRECTORY_REGISTRY_FILE],
    { env, readOnly: true },
  );
  const entries = stdout.split("\0").filter(Boolean);
  if (!entries.length) return null;
  const match = /^(100644|100755) (?:blob )?([a-f0-9]{40,64})(?: 0)?\t/.exec(
    entries[0],
  );
  if (entries.length !== 1 || !match)
    throw new Error(
      "Resolve the Design directory registry's Git conflict or file type before continuing.",
    );
  const blob = await runGit(cwd, ["cat-file", "blob", match[2]], {
    env,
    readOnly: true,
    maxBufferBytes: 16 * 1024 * 1024,
  });
  return parseDesignDirectoryRegistry(blob.stdout);
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
  env?: IndexEnv,
): Promise<void> {
  if (!Object.keys(registry.directories).length) {
    await runGit(
      cwd,
      ["update-index", "--force-remove", "--", DESIGN_DIRECTORY_REGISTRY_FILE],
      { env },
    );
    return;
  }
  const blob = await runGit(cwd, ["hash-object", "-w", "--stdin"], {
    input: stringify(registry) + "\n",
    env,
  });
  await runGit(
    cwd,
    [
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob.stdout.trim()},${DESIGN_DIRECTORY_REGISTRY_FILE}`,
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
  const index = await designRegistryAtGitRef(cwd, ":");
  let next = readDesignDirectoryRegistry(cwd);
  if (unstage) {
    let head: string | null = null;
    try {
      head = (
        await runGit(cwd, ["rev-parse", "--verify", "HEAD"])
      ).stdout.trim();
    } catch {
      /* unborn */
    }
    next = await designRegistryAtGitRef(cwd, head);
  }
  const projected = projectDirectory(
    index,
    next,
    directory,
    readDesignDirectoryRegistry(cwd),
  );
  if (!index && !Object.keys(projected.directories).length) return;
  await writeIndexRegistry(cwd, projected);
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
    designRegistryAtGitRef(cwd, head),
    designRegistryAtGitRef(cwd, ":", env),
  ]);
  if (!base && !staged) return;
  await writeIndexRegistry(
    cwd,
    projectDirectory(base, staged, directory, readDesignDirectoryRegistry(cwd)),
    env,
  );
}
