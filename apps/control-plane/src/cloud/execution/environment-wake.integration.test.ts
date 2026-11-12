import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { checkpointArchiveSteps, parseCheckpointResult, sealCheckpointKey } from "../checkpoint.js";
import { pinCloudEnvironment } from "../environment-store.js";
import { CloudProviderError } from "../provider-error.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("active environment isolation across real start and prompt wake routes", () => {
  let pool: pg.Pool, f: ExecutionFixture, directory: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 6000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { lifecycle: true });
    await f.cp.lifecycleChanges!.stop(); await f.cp.loginChanges.stop();
    directory = mkdtempSync(join(tmpdir(), "execution-environment-wake-"));
  });
  afterEach(async () => { await f?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  it.each([
    { route: "start", restore: false }, { route: "prompt", restore: false },
    { route: "start", restore: true }, { route: "prompt", restore: true },
  ])("$route (replacement=$restore) keeps the Creator pin without placing its files in the shared checkout", async scenario => {
    const content = "SYNTHETIC_CREATOR=fixture-only\n", seedPath = ".env.fixture";
    const saved = await f.cp.routes.environments!.patch(f.organizationId, f.creator.id, "42", f.workspace.repository,
      { expectedRevision: 0, files: [{ path: seedPath, content }] });
    await withSystemTx(pool, tx => pinCloudEnvironment(tx, f.workspace, "42"));
    await f.login(); await f.activate(f.viewer);
    const oldHome = join(directory, "old"), home = join(directory, "current"), origin = join(directory, "origin.git");
    const oldRepo = join(oldHome, f.workspace.repository), repo = join(home, f.workspace.repository);
    const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: oldHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
    const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", args, { cwd, env, stdio: "pipe" });
    mkdirSync(oldRepo, { recursive: true });
    git(directory, "init", "-q", "--bare", "-b", "main", origin); git(oldRepo, "init", "-q", "-b", "main");
    writeFileSync(join(oldRepo, ".gitignore"), ".env*\n"); writeFileSync(join(oldRepo, "README.md"), "member work\n");
    git(oldRepo, "add", "."); git(oldRepo, "commit", "-q", "-m", "fixture");
    git(oldRepo, "remote", "add", "origin", origin); git(oldRepo, "push", "-q", "-u", "origin", "main");
    writeFileSync(join(oldRepo, seedPath), content);
    const seed = join(oldHome, ".local/share/zeros/cloud-worker/environment-seed"); mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, "manifest.json"), JSON.stringify({ version: 2, versionId: saved.versionId, complete: true,
      files: [{ path: seedPath, alias: randomUUID(), phase: "complete", sha256: createHash("sha256").update(content).digest("hex") }] }));
    const key = randomBytes(32), archive = join(directory, "checkpoint.zck");
    const captured = spawnSync("bash", ["-c", [...checkpointArchiveSteps({ home: oldHome, checkoutPath: oldRepo, baseBranch: "main", key }),
      `cp "$work/checkpoint.zck" '${archive}'`, "report \"zeros-checkpoint-saved bytes=$bytes sha256=$sha\""].join("\n")], { env, encoding: "utf8" });
    const checkpoint = parseCheckpointResult(captured.stdout); expect(checkpoint, JSON.stringify(checkpoint)).toMatchObject({ ok: true });
    if (!checkpoint.ok || checkpoint.unchanged) throw new Error("Fixture checkpoint not captured");
    const object = `cloud-v2/checkpoints/${f.workspace.id}/${randomUUID()}.zck`, build = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_computer_builds(id,org_id,version,recipe,state,snapshot_id,created_by,source_policy_version,source_targets)
      VALUES($1,$2,1,$4,'succeeded','fixture-snapshot',$3,2,$5)`, [build, f.organizationId, f.creator.id,
      { repositories: [{ repository: f.workspace.repository, branch: "main" }] }, JSON.stringify([{ repository: f.workspace.repository, repositoryId: "42" }])]);
    await pool.query("INSERT INTO cloud_v2_computers(org_id,active_build_id,snapshot_name,refresh_next_at) VALUES($1,$2,'fixture-snapshot',clock_timestamp()+interval '1 day')", [f.organizationId, build]);
    await pool.query(`UPDATE cloud_v2_workspaces SET state='stopped',worker_token_hash=NULL,worker_boot_id=NULL,
      checkpoint_object=$2,checkpoint_key=$3,checkpoint_sha256=$4,checkpoint_bytes=$5,checkpoint_saved_at=clock_timestamp(),
      checkpoint_stop_generation=stop_generation,lease_renewed_at=clock_timestamp() WHERE id=$1`,
    [f.workspace.id, object, sealCheckpointKey(key, f.workspace.id, object, f.keys), checkpoint.sha256, checkpoint.bytes]);
    if (!scenario.restore) { mkdirSync(dirname(repo), { recursive: true }); git(directory, "clone", "-q", origin, repo); }

    // Provider boundaries are local files/Git; the captured production command
    // still performs the real archive decrypt, filtering and disk writes.
    const bin = join(directory, "bin"); mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(join(bin, "curl"), `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);fs.copyFileSync(${JSON.stringify(archive)},a[a.indexOf('-o')+1]);`, { mode: 0o755 });
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const cp=require('node:child_process'),a=process.argv.slice(2);
if(a.includes('fetch')) { const i=a.indexOf(${JSON.stringify(`https://github.com/${f.workspace.repository}.git`)});if(i<0)process.exit(2);a[i]=${JSON.stringify(origin)};a.unshift('-c','protocol.file.allow=always');process.env.GIT_ALLOW_PROTOCOL='file'; }
const r=cp.spawnSync('/usr/bin/git',a,{stdio:'inherit',env:process.env});process.exit(r.status??1);`, { mode: 0o755 });
    const ready = { exitCode: 0, stdout: "", timedOut: false };
    const scripts: Array<{ status: number | null; stdout: string }> = [];
    vi.spyOn(f.cp.compute, "create").mockResolvedValue({ sandboxId: "bx_environment_restore" });
    vi.spyOn(f.cp.compute, "resume").mockImplementation(async () => { if (scenario.restore) throw new CloudProviderError("provider_not_found", "Fixture missing VM", false); });
    vi.spyOn(f.cp.compute, "hostPort").mockResolvedValue({ url: "https://fixture.example.test", token: "synthetic-port-value" });
    vi.spyOn(f.cp.compute, "exec").mockImplementation(async (_id, command) => {
      if (!command.includes("zeros-checkpoint-restored")) return ready;
      const local = command.replaceAll("/home/user", home).replaceAll("/usr/local/bin:/usr/bin:/bin", `${bin}:/usr/bin:/bin`);
      const result = spawnSync("bash", ["-c", local], { env, encoding: "utf8", timeout: 20_000 });
      scripts.push({ status: result.status, stdout: result.stdout.trim() });
      return { exitCode: result.status ?? 1, stdout: result.stdout, timedOut: !!result.error };
    });
    vi.spyOn(f.cp.runtimeUpdates, "tick").mockResolvedValue();
    const started = scenario.route === "start"
      ? await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/start`, "POST", undefined, f.viewer, { "X-Zeros-Team-Sharing": "1" })
      : await f.send(f.prompt(), f.viewer);
    expect(started.status).toBe(scenario.route === "start" ? 202 : 201);
    await f.cp.lifecycle!.tick();
    expect(vi.mocked(f.cp.compute.exec).mock.calls.filter(([, command]) => command.includes("zeros-checkpoint-restored"))).toHaveLength(scenario.restore ? 1 : 0);
    expect(scripts).toEqual(scenario.restore ? [{ status: 0, stdout: "zeros-checkpoint-restored" }] : []);
    expect(existsSync(join(repo, seedPath))).toBe(false);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("member work\n");
    expect((await pool.query("SELECT version_id FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [f.workspace.id])).rows)
      .toEqual([{ version_id: saved.versionId }]);
    const token = await f.cp.store.rotateWorkerToken(f.workspace.id), boot = randomUUID();
    const hello = await f.worker("hello", { protocol: 2, bootId: boot, runtimeSha256: "b".repeat(64) }, { token, boot });
    const reply = await hello.json();
    expect({ status: hello.status, code: reply.error?.code }).toEqual({ status: 200, code: undefined });
    expect(reply.config).not.toHaveProperty("environment");
  }, 30_000);
});
