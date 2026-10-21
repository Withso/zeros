import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

// Null means absent; undefined means uncertain. An unreadable loose ref must
// never fall through to a potentially older packed value.
async function readMetadata(file: string, limit: number): Promise<string | null | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(await realpath(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) return undefined;
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytesRead) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return undefined;
    return buffer.toString("utf8", 0, bytesRead);
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined; }
  finally { await handle?.close(); }
}

/** Read only the ordinary Local files-ref format. Unsupported layouts,
 * missing refs, reftable and concurrent metadata changes stay native Git reads.
 * No HEAD value is retained between calls. */
export async function readLocalHead(gitDirectory: string): Promise<string | undefined> {
  const commonPointer = await readMetadata(path.join(gitDirectory, "commondir"), 4096);
  if (commonPointer === undefined || (commonPointer !== null && (!commonPointer.trim() || commonPointer.includes("\0")))) return undefined;
  const common = commonPointer === null ? gitDirectory : path.resolve(gitDirectory, commonPointer.trim());
  try { await stat(path.join(common, "reftable")); return undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
  let ref = "HEAD";
  for (let depth = 0; depth < 8; depth += 1) {
    const contents = await readMetadata(path.join(ref === "HEAD" ? gitDirectory : common, ref), 4096);
    if (contents === undefined) return undefined;
    if (contents === null) {
      if (ref === "HEAD") return undefined;
      const packed = await readMetadata(path.join(common, "packed-refs"), 4 * 1024 * 1024);
      for (const line of packed?.split("\n") ?? []) {
        const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/.exec(line);
        if (match?.[2] === ref) return match[1];
      }
      return undefined;
    }
    const value = contents.trim();
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) return value;
    if (!value.startsWith("ref: ")) return undefined;
    ref = value.slice(5);
    if (!/^refs\/[A-Za-z0-9_./-]+$/.test(ref) || ref.includes("..") ||
        /^refs\/(?:worktree|bisect|rewritten)\//.test(ref)) return undefined;
  }
  return undefined;
}
