import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveGitdir } from "./repo";
import type { Workspace } from "./types";
import { workspaceChangeKey } from "./workspace-change-probe";

const MAX_ENTRIES = 128;
interface GraphResult { value: string | null; complete: boolean }
const graphReads = new Map<string, Promise<GraphResult>>();

function safeRefPath(ref: string): boolean {
  // Revision expressions and per-worktree reference namespaces do not map to
  // the ordinary loose/shared ref candidates below. Keep them native reads.
  return ref.length < 1024 && !ref.startsWith("/") &&
    ![...ref].some((char) => char.charCodeAt(0) <= 32 || "\\~^:?*[{}".includes(char)) && !ref.includes("..") &&
    !/^(?:refs\/(?:worktree|bisect|rewritten)\/|worktrees\/|main-worktree\/)/.test(ref);
}

/** Only graph inputs are retained between refreshes. Working-tree contents
 * are always observed again: the packaged Local watcher can lag an external
 * edit, and an explicit read must not wait for its next polling interval. */
async function graphFingerprint(workspace: Workspace, remote: string, branch: string | null): Promise<string | null> {
  try {
    const gitDir = await resolveGitdir(workspace.path);
    const values = new Map<string, string>();
    const readSmall = async (file: string): Promise<string | null> => {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const target = await realpath(file);
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || info.size > 4096n) throw new Error("unsupported Git metadata");
        const buffer = Buffer.alloc(Number(info.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const content = buffer.toString("utf8", 0, bytesRead);
        values.set(file, [target, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, content].join(":"));
        return content.trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
        values.set(file, "missing");
        return null;
      } finally {
        await handle?.close();
      }
    };
    const commonPointer = await readSmall(path.join(gitDir, "commondir"));
    const common = commonPointer ? path.resolve(gitDir, commonPointer) : gitDir;
    // Reftable has its own atomic table-list protocol. Fall back to native Git
    // until that format has an equally complete fingerprint.
    try { await stat(path.join(common, "reftable")); return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }

    const metadata = [
      path.join(gitDir, "HEAD"), path.join(gitDir, "config.worktree"),
      path.join(common, "packed-refs"), path.join(common, "shallow"),
      path.join(common, "config"), path.join(common, "info", "grafts"),
      ...(branch && safeRefPath(branch) ? [path.join(common, "logs", "refs", "heads", branch)] : []),
    ];
    const recordMetadata = async (file: string): Promise<void> => {
      try {
        const link = await lstat(file, { bigint: true });
        const target = link.isSymbolicLink() ? await stat(file, { bigint: true }) : link;
        values.set(file, [link.dev, link.ino, link.size, link.mtimeNs, link.ctimeNs,
          target.dev, target.ino, target.size, target.mtimeNs, target.ctimeNs].join(":"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
        values.set(file, "missing");
      }
    };
    await Promise.all(metadata.map(recordMetadata));
    const refs = new Set([workspace.baseBranch, `${remote}/${workspace.baseBranch}`, `origin/${workspace.baseBranch}`,
      `${remote}/HEAD`, "main", "master", `${remote}/main`, `${remote}/master`, "HEAD"]);
    if ([...refs].some((ref) => !safeRefPath(ref))) return null;
    const visited = new Set<string>();
    const readRef = async (file: string, depth = 0): Promise<void> => {
      if (visited.has(file)) return;
      if (depth > 8) throw new Error("Git symbolic reference depth exceeded");
      visited.add(file);
      const content = await readSmall(file);
      if (content?.startsWith("ref: ")) {
        const target = content.slice(5);
        if (!safeRefPath(target)) throw new Error("unsupported Git symbolic reference");
        if (file === path.join(gitDir, "HEAD") && target.startsWith("refs/heads/")) {
          await recordMetadata(path.join(common, "logs", target));
        }
        await readRef(path.join(common, target), depth + 1);
      }
    };
    const candidates = new Set<string>();
    for (const ref of refs) {
      // Git's documented ref-name disambiguation order, including tags and
      // symbolic remote HEADs, all contribute to a base-name comparison.
      for (const name of [ref, `refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`, `refs/remotes/${ref}`, `refs/remotes/${ref}/HEAD`]) {
        candidates.add(path.join(common, name));
      }
    }
    candidates.add(path.join(gitDir, "HEAD"));
    await Promise.all([...candidates].map((file) => readRef(file)));
    return createHash("sha256").update(JSON.stringify([...values].sort(([left], [right]) => left.localeCompare(right)))).digest("hex");
  } catch {
    // Unusual metadata layouts and inaccessible paths remain native reads.
    return null;
  }
}

export async function readLocalGitGraph(
  workspace: Workspace,
  remote: string,
  observed: { head: string | null; branch: string | null },
  read: () => Promise<GraphResult>,
): Promise<string | null> {
  if (workspace.placement === "cloud") return (await read()).value;
  const fingerprint = await graphFingerprint(workspace, remote, observed.branch);
  if (!fingerprint) return (await read()).value;
  const key = JSON.stringify([workspaceChangeKey(workspace, remote), observed.head, observed.branch, fingerprint]);
  const cached = graphReads.get(key);
  if (cached) {
    graphReads.delete(key);
    graphReads.set(key, cached);
    return (await cached).value;
  }
  const flight = read();
  graphReads.set(key, flight);
  while (graphReads.size > MAX_ENTRIES) graphReads.delete(graphReads.keys().next().value!);
  try {
    const result = await flight;
    if (!result.complete || await graphFingerprint(workspace, remote, observed.branch) !== fingerprint) graphReads.delete(key);
    return result.value;
  } catch (error) {
    if (graphReads.get(key) === flight) graphReads.delete(key);
    throw error;
  }
}
