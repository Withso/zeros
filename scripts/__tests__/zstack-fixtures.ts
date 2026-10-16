import { constants } from "node:fs";
import { mkdtemp, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function privateFixtureRoot(cleanup: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zstack-fixture-"));
  cleanup.push(root);
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await directory.stat();
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700)
      throw new Error("fixture_directory_unsafe");
    return await realpath(root);
  } finally { await directory.close(); }
}

export async function readFixtureReceipt(file: string): Promise<unknown> {
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await input.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600)
      throw new Error("fixture_receipt_unsafe");
    return JSON.parse(await input.readFile("utf8"));
  } finally { await input.close(); }
}
