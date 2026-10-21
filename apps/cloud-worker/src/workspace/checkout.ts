import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import { WorkspaceError, type WorkerConfig } from "./scope";

const exec = promisify(execFile);

/** Run only for the first config in a worker process. Existing branches and
 * dirty files remain owned by the user; Git refuses an unsafe switch itself. */
export async function prepareCheckout(workspace: WorkerConfig["workspace"], gitEnvironment: NodeJS.ProcessEnv = {}): Promise<void> {
  const run = (...args: string[]) => exec("git", args, { cwd: workspace.checkoutPath, env: workerChildEnvironment(undefined, gitEnvironment), timeout: 120_000, maxBuffer: 1024 * 1024 });
  for (const branch of [workspace.branch, workspace.baseBranch]) {
    if (branch.startsWith("-")) throw new WorkspaceError("VALIDATION_FAILED", "Invalid workspace branch.");
    try { await run("check-ref-format", `refs/heads/${branch}`); }
    catch { throw new WorkspaceError("VALIDATION_FAILED", "Invalid workspace branch."); }
  }
  try {
    await run("fetch", "origin");
    const exists = await run("show-ref", "--verify", "--quiet", `refs/heads/${workspace.branch}`).then(() => true, (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === 1) return false;
      throw error;
    });
    if (exists) await run("switch", "--", workspace.branch);
    else await run("switch", "--no-track", "-c", workspace.branch, `origin/${workspace.baseBranch}`);
  } catch { throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "Could not prepare the workspace branch. Existing work has been retained."); }
}
