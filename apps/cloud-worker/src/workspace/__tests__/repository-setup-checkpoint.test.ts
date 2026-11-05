import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CloudWorker } from "../../worker";
import { config, FakeRelay } from "../../__tests__/worker-fixtures";
import { repositoryFixture } from "./repository-fixture";
import { checkpointArchiveSteps, checkpointRestoreSteps, CLOUD_V2_WORKER_STATE, parseCheckpointResult, parseRestoreResult } from "../../../../control-plane/src/cloud/checkpoint";

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
function run(steps: string[]) {
  const result = spawnSync("bash", ["-c", steps.join("\n")], { encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
  expect(result.status).toBe(0);
  return result.stdout;
}

it("runs the selected script once per disk after seeded files, including actual encrypted checkpoint restore", async () => {
  const f = await repositoryFixture(), home = join(f.directory, "home"), state = join(home, CLOUD_V2_WORKER_STATE);
  await mkdir(state, { recursive: true });
  await writeFile(join(f.root, ".gitignore"), ".env*\nnode_modules/\n");
  await writeFile(join(f.root, "setup.sh"), "test -s .env.local || exit 7\nmkdir -p node_modules\nprintf ran >> node_modules/setup-proof\n");
  await f.git("add", ".gitignore", "setup.sh"); await f.git("commit", "-m", "setup and environment fixture");
  const environment = { versionId: randomUUID(), repositoryId: "42", variables: {}, files: [{ path: ".env.local", content: "VALUE=synthetic-restore-setup\n" }] };
  const configuration = { ...config, agents: {}, workspace: { ...f.scope.workspace, setupScript: "setup.sh", setup: "exit 99" }, environment };
  const start = async (createdBranch: boolean) => {
    let confirmed = false;
    const relay = Object.assign(new FakeRelay(), { reportEnvironment: async () => { confirmed = true; } });
    const worker = new CloudWorker({ directory: state, homeDirectory: home, transport: relay, drivers: {}, workspaceServices: { watch: false },
      prepareCheckout: async () => ({ createdBranch }) });
    worker.start();
    try { await relay.receive(configuration); expect(confirmed).toBe(true); }
    catch (error) { await worker.dispose(); throw error; }
    return { worker, relay };
  };
  const proof = join(f.root, "node_modules/setup-proof"), status = join(state, "workspace-setup", `${f.scope.workspace.id}.json`);
  const first = await start(true);
  try { await expect.poll(() => readFile(proof, "utf8").catch(() => "")).toBe("ran"); }
  finally { await first.worker.dispose(); }
  const wake = await start(false);
  try { await wake.relay.receive(configuration); expect(await readFile(proof, "utf8")).toBe("ran"); }
  finally { await wake.worker.dispose(); }

  const origin = join(f.directory, "origin.git"), key = randomBytes(32), archive = join(f.directory, "setup.zck");
  await f.git("clone", "--bare", f.root, origin);
  const saved = run([...checkpointArchiveSteps({ checkoutPath: f.root, home, baseBranch: "main", key }),
    `cp "$work/checkpoint.zck" ${quote(archive)}`, 'report "zeros-checkpoint-saved bytes=$bytes sha256=$sha"']);
  expect(parseCheckpointResult(saved).ok).toBe(true);
  const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  await rm(home, { recursive: true }); await rm(f.root, { recursive: true });
  await mkdir(f.root); await f.git("clone", origin, ".");
  const restored = run([...checkpointRestoreSteps({ checkoutPath: f.root, home, key, sha256 }, [`cp ${quote(archive)} "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"]);
  expect(parseRestoreResult(restored)).toEqual({ ok: true });
  await expect(readFile(proof)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(status)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.root, ".env.local"), "utf8")).toBe(environment.files[0]!.content);
  const replacement = await start(false);
  try {
    await expect.poll(() => readFile(proof, "utf8").catch(() => "")).toBe("ran");
    await replacement.relay.receive(configuration);
    await expect.poll(async () => JSON.parse(await readFile(status, "utf8")).state).toBe("succeeded");
    expect(await readFile(proof, "utf8")).toBe("ran");
    await expect(readFile(join(state, "restored-from-checkpoint"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await replacement.worker.dispose(); }
}, 30_000);
