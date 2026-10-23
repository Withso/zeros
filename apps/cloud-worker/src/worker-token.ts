import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const WORKER_TOKEN_FILE = "/home/user/.config/zeros/worker-token";

export async function readWorkerToken(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Invalid credential file.");
    const token = (await file.readFile("utf8")).trim();
    if (!token || token.length > 8192 || /[\s\0]/.test(token)) throw new Error("Invalid credential file.");
    return token;
  } finally { await file.close(); }
}
