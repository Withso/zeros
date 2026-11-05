import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkspaceSetup } from "../setup";
import { ApplicationEnvironment } from "../../credentials/application-environment";
import { repositoryFixture } from "./repository-fixture";

const canary = "synthetic_private_app_value";
async function execute(body: string, variables: Record<string, string> = {}) {
  const f = await repositoryFixture();
  await writeFile(join(f.root, "setup.sh"), body);
  await f.git("add", "setup.sh"); await f.git("commit", "-m", "synthetic diagnostics");
  const setup = new WorkspaceSetup({ directory: f.state,
    workspace: { ...f.scope.workspace, setupScript: "setup.sh", setup: "printf 'default setup\\n'" },
    gitEnvironment: {}, application: new ApplicationEnvironment({ variables, files: [] }), activity() {} });
  try {
    setup.start(true); await expect.poll(() => setup.busy).toBe(false);
    const prefix = join(f.state, "workspace-setup", f.scope.workspace.id);
    return { log: await readFile(`${prefix}.log`, "utf8"), status: JSON.parse(await readFile(`${prefix}.json`, "utf8")) };
  } finally { await setup.dispose(); }
}

it.each([
  ["unexpected token", `for item in a; ${canary}; do :; done\n`, "syntax error"],
  ["expansion expression", 'printf \'%s\' "${' + canary + '!}"\n', "bad substitution"],
  ["source line", `if then ${canary}\n`, "syntax error"],
])("redacts admitted app values in native %s diagnostics", async (_name, body, diagnostic) => {
  const result = await execute(body!, { APP_SECRET: canary });
  expect(result.status.state).toBe("failed");
  expect(result.log).toContain(diagnostic);
  expect(result.log).not.toContain(canary);
  expect(result.log).toContain("[redacted]");
});

it("keeps ordinary intentional setup output usable", async () => {
  const result = await execute("printf 'ordinary setup output\\n'\n");
  expect(result.status.state).toBe("succeeded");
  expect(result.log).toBe("ordinary setup output\n");
});
