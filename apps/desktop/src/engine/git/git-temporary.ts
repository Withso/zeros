import { mkdtemp, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { gitExecutionIdentity } from "./git-execution-identity";

/** Git runs as the checkout owner on cloud workers. Only these disposable
 * workspace bytes cross that identity boundary; engine authority never does.
 * Local Git retains private, same-user temporary storage. */
export async function createGitTemporaryDirectory(prefix: string): Promise<string> {
  const identity = gitExecutionIdentity();
  const directory = await mkdtemp(prefix);
  try {
    if (identity) {
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.chown(identity.uid, identity.gid); }
      finally { await handle.close(); }
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function writeGitTemporaryFile(
  destination: string,
  contents: string | Uint8Array | AsyncIterable<Uint8Array>,
): Promise<void> {
  const identity = gitExecutionIdentity();
  // Exclusive creation refuses existing files/symlinks. Grant ownership by
  // descriptor, never by a pathname a workspace process could replace.
  const handle = await open(destination, "wx", 0o600);
  try {
    if (typeof contents === "string" || contents instanceof Uint8Array) {
      await handle.writeFile(contents);
    } else {
      for await (const chunk of contents) await handle.writeFile(chunk);
    }
    if (identity) await handle.chown(identity.uid, identity.gid);
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

export async function copyGitTemporaryFile(source: string, destination: string): Promise<void> {
  // Opening first pins the complete old/new index through Git's atomic rename.
  // Stream it to bound memory for large repositories.
  const identity = gitExecutionIdentity();
  const input = await open(source, identity ? constants.O_RDONLY | constants.O_NOFOLLOW : "r");
  try {
    if (identity) {
      const stat = await input.stat();
      if (!stat.isFile() || stat.uid !== identity.uid)
        throw new Error("Git snapshot source is not owned by the workspace");
    }
    await writeGitTemporaryFile(destination, input.createReadStream({ autoClose: false }));
  } finally {
    await input.close();
  }
}
