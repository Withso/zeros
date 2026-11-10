import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readSetupOutput } from "../setup";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const workspaceId = "22222222-2222-4222-8222-222222222222";

it("reads the newest lines of this workspace's setup log, bounded, and nothing before setup ran", async () => {
  const directory = await mkdtemp(join(tmpdir(), "setup-output-")); directories.push(directory);
  expect(await readSetupOutput(directory, workspaceId, 10)).toBeUndefined();
  await mkdir(join(directory, "workspace-setup"));
  await writeFile(join(directory, "workspace-setup", `${workspaceId}.log`), "pnpm install\r\nProgress: 1\rProgress: 2\nDone in 3s\n\n");
  expect(await readSetupOutput(directory, workspaceId, 10)).toEqual({ lines: ["pnpm install", "Progress: 2", "Done in 3s"], truncated: false });
  expect(await readSetupOutput(directory, workspaceId, 2)).toEqual({ lines: ["Progress: 2", "Done in 3s"], truncated: true });
  await writeFile(join(directory, "workspace-setup", `${workspaceId}.log`), Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n"));
  const tail = await readSetupOutput(directory, workspaceId, 2000, 16 * 1024);
  expect(tail!.truncated).toBe(true);
  expect(tail!.lines.at(-1)).toMatch(/^line 4999 /);
  expect(tail!.lines.join("\n").length).toBeLessThanOrEqual(16 * 1024);
  expect(tail!.lines[0]).toMatch(/^line \d+ x+$/);
});

it("refuses a log path replaced by a link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "setup-output-")); directories.push(directory);
  await mkdir(join(directory, "workspace-setup"));
  await writeFile(join(directory, "secret.txt"), "private\n");
  await symlink(join(directory, "secret.txt"), join(directory, "workspace-setup", `${workspaceId}.log`));
  expect(await readSetupOutput(directory, workspaceId, 10)).toBeUndefined();
});
