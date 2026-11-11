import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commandRunner } from "../commands";
import { operationEnvironment } from "../../sharing/operation-environment";

it("gives a command its operation's person and context, and nothing outside an operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-operation-"));
  try {
    const run = commandRunner(directory, { GIT_ASKPASS: "/worker/askpass" });
    const outside = (await run("git", ["-c", "alias.zenv=!env", "zenv"])).stdout;
    expect(outside).not.toMatch(/GIT_AUTHOR_NAME|ZEROS_EXECUTION_CONTEXT/);
    const inside = (await operationEnvironment.run({ git: { GIT_AUTHOR_NAME: "Alex", GIT_COMMITTER_NAME: "Alex" }, zeros: { ZEROS_EXECUTION_CONTEXT: "66666666-6666-4666-8666-666666666666" } },
      () => run("git", ["-c", "alias.zenv=!env", "zenv"]))).stdout;
    expect(inside).toContain("GIT_AUTHOR_NAME=Alex"); expect(inside).toContain("GIT_COMMITTER_NAME=Alex");
    expect(inside).toContain("ZEROS_EXECUTION_CONTEXT=66666666-6666-4666-8666-666666666666"); expect(inside).toContain("GIT_ASKPASS=/worker/askpass");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
