import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readWorkerToken } from "../worker-token";

let directory: string, file: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "worker-token-")); file = join(directory, "token"); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("waits for a private credential file and reads rotations without caching", async () => {
  await expect(readWorkerToken(file)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(file, "synthetic-first-worker-token\n", { mode: 0o600 });
  expect(await readWorkerToken(file)).toBe("synthetic-first-worker-token");
  await writeFile(file, "synthetic-rotated-worker-token");
  expect(await readWorkerToken(file)).toBe("synthetic-rotated-worker-token");
});

it("refuses readable-by-others credentials, symlinks and directories", async () => {
  await writeFile(file, "synthetic-worker-token", { mode: 0o644 });
  await expect(readWorkerToken(file)).rejects.toThrow("Invalid credential file");
  await chmod(file, 0o600);
  const link = join(directory, "link"); await symlink(file, link);
  await expect(readWorkerToken(link)).rejects.toMatchObject({ code: "ELOOP" });
  const folder = join(directory, "folder"); await mkdir(folder, { mode: 0o700 });
  await expect(readWorkerToken(folder)).rejects.toThrow("Invalid credential file");
});

it.each(["", "synthetic worker token", "synthetic\0token", "x".repeat(8193)])("refuses malformed or oversized credentials", async token => {
  await writeFile(file, token, { mode: 0o600 });
  await expect(readWorkerToken(file)).rejects.toThrow("Invalid credential file");
});
