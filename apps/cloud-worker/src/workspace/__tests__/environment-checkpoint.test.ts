import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedEnvironment } from "../environment-seed";
import { repositoryFixture } from "./repository-fixture";
import { checkpointArchiveSteps, checkpointRestoreSteps, CLOUD_V2_WORKER_STATE, parseCheckpointResult, parseRestoreResult } from "../../../../control-plane/src/cloud/checkpoint";

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const run = (script: string[]) => {
  const result = spawnSync("bash", ["-c", script.join("\n")], { encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
  return { status: result.status, stdout: result.stdout };
};
async function fixture() {
  const f = await repositoryFixture(), home = join(f.directory, "home"), state = join(home, CLOUD_V2_WORKER_STATE);
  await mkdir(state, { recursive: true });
  await writeFile(join(f.root, ".gitignore"), ".env*\nprivate-env/\n");
  await f.git("add", ".gitignore"); await f.git("commit", "-m", "ignore environment");
  const environment = { versionId: randomUUID(), repositoryId: "42", variables: { APP_SECRET: "synthetic-app-only" }, files: [
    { path: ".env.local", content: "VALUE=synthetic-root-only\n" },
    { path: "private-env/.env.local", content: 'VALUE="synthetic-file-only"\n' },
    { path: "private-env/.env.deleted", content: "VALUE=synthetic-deleted-only\n" },
  ] };
  await seedEnvironment(f.scope, state, environment, new AbortController().signal);
  return { ...f, home, state, environment };
}
it("keeps edited and deleted environment selections through actual encrypted VM-loss restore without reseeding", async () => {
  const f = await fixture(), origin = join(f.directory, "origin.git"), key = randomBytes(32), archive = join(f.directory, "environment.zck");
  await f.git("clone", "--bare", f.root, origin);
  await writeFile(join(f.root, "private-env/.env.local"), "VALUE=synthetic-edited\n");
  await rm(join(f.root, "private-env/.env.deleted"));
  const steps = checkpointArchiveSteps({ checkoutPath: f.root, home: f.home, baseBranch: "main", key });
  const manifest = join(f.directory, "capture-manifest.json");
  steps.splice(steps.indexOf("step=pack"), 0, `tar -xOf "$c/environment.tar" ./manifest.json > ${quote(manifest)}`);
  const saved = run([...steps, `cp "$work/checkpoint.zck" ${quote(archive)}`, 'report "zeros-checkpoint-saved bytes=$bytes sha256=$sha"']);
  expect(saved.status).toBe(0); expect(parseCheckpointResult(saved.stdout).ok).toBe(true);
  const ciphertext = await readFile(archive), metadata = await readFile(manifest, "utf8");
  for (const value of [...Object.values(f.environment.variables), ...f.environment.files.map(file => file.content), "synthetic-edited"])
    expect(ciphertext.includes(Buffer.from(value)) || metadata.includes(value) || saved.stdout.includes(value)).toBe(false);
  const sha256 = createHash("sha256").update(ciphertext).digest("hex");
  await rm(f.home, { recursive: true, force: true }); await rm(f.root, { recursive: true, force: true });
  await mkdir(f.root); await f.git("clone", origin, ".");
  await mkdir(join(f.root, "private-env")); await writeFile(join(f.root, "private-env/.env.deleted"), "image-default");
  const restored = run([...checkpointRestoreSteps({ checkoutPath: f.root, home: f.home, key, sha256 }, [`cp ${quote(archive)} "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"]);
  expect(restored.status).toBe(0); expect(parseRestoreResult(restored.stdout)).toEqual({ ok: true });
  await seedEnvironment(f.scope, f.state, f.environment, new AbortController().signal);
  expect(await readFile(join(f.root, "private-env/.env.local"), "utf8") === "VALUE=synthetic-edited\n").toBe(true);
  expect((await stat(join(f.root, "private-env/.env.local"))).mode & 0o777).toBe(0o600);
  await expect(stat(join(f.root, "private-env/.env.deleted"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.root, ".env.local"), "utf8") === f.environment.files[0]!.content).toBe(true);
}, 30_000);

it.each(["symlink", "hardlink", "nested-owner", "oversized"])("refuses %s selected environment capture without logging values", async kind => {
  const f = await fixture(), path = join(f.root, "private-env/.env.local");
  if (kind === "symlink" || kind === "hardlink") {
    const outside = join(f.home, "outside"); await writeFile(outside, "synthetic-outside-only"); await rm(path);
    if (kind === "symlink") await symlink(outside, path); else await link(outside, path);
  }
  if (kind === "nested-owner") await mkdir(join(f.root, "private-env/.git"));
  if (kind === "oversized") await writeFile(path, Buffer.alloc(64 * 1024 + 1));
  const saved = run(checkpointArchiveSteps({ checkoutPath: f.root, home: f.home, baseBranch: "main", key: randomBytes(32) }));
  expect(parseCheckpointResult(saved.stdout)).toMatchObject({ ok: false, code: kind === "oversized" ? "checkpoint_too_large" : "checkpoint_failed" });
  expect(saved.stdout.includes("synthetic-")).toBe(false);
}, 30_000);
