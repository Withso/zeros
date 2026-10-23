import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach } from "vitest";
import { config } from "../../__tests__/worker-fixtures";
import { workerChildEnvironment } from "../../drivers/shared/agent-environment";
import { WorkspaceScope } from "../scope";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

export async function repositoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "worker-services-")); roots.push(directory);
  const root = join(directory, "checkout"), state = join(directory, "state");
  await mkdir(root); await mkdir(state);
  const git = async (...args: string[]) => (await exec("git", args, { cwd: root, env: workerChildEnvironment(), timeout: 10_000 })).stdout.trim();
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "readme.txt"), "initial\n");
  await git("add", "."); await git("commit", "-m", "initial");
  await git("switch", "-c", "workspace/fixture");
  const scope = new WorkspaceScope({ ...config.workspace, checkoutPath: root });
  return { directory, root, state, scope, git };
}
