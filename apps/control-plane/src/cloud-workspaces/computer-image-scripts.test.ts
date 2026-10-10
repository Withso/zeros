import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { releaseImageSanitation } from "./computer-image-scripts.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-image-sanitation-")); roots.push(root);
  const commit = "a".repeat(40), build = JSON.stringify({ source: { commit } });
  for (const directory of ["run/zeros", "etc/zeros"]) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, "run/zeros/engine.lock"), "");
  await writeFile(path.join(root, "etc/zeros/image-build.json"), build);
  let script = releaseImageSanitation.split("<<'PY'\n")[1]!.split("\nPY\n")[0]!;
  for (const prefix of ["/run/zeros", "/etc/zeros", "/sys/fs/cgroup", "/srv/zeros", "/root", "/home/user", "/opt/zeros"])
    script = script.replaceAll(prefix, path.join(root, prefix));
  script = script.replaceAll("{{BUILD_SHA256}}", createHash("sha256").update(build).digest("hex")).replaceAll("{{SOURCE_COMMIT}}", commit);
  const run = () => promisify(execFile)("python3", ["-c", "import subprocess,types\nsubprocess.run=lambda *a,**k:types.SimpleNamespace(returncode=3)\n" + script]);
  async function file(relative: string) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), "synthetic-state"); }
  return { root, run, file };
}
it("keeps the existing closed sanitation result for a clean image", async () => {
  const f = await fixture(); const result = JSON.parse((await f.run()).stdout);
  expect(result).toMatchObject({ qualified: true, nativeHistoryFiles: 0, knownCredentialFiles: 0, coordinatorEntries: 0 });
  expect(result).not.toHaveProperty("agentIsolation");
});
it.each(["home/.codex/auth.json", "home/.claude/.credentials.json", "state/provider-cache.json"])("refuses physical native HOME state before release (%s)", async name => {
  const f = await fixture();
  await f.file(`srv/zeros/state/native-agent-homes/conversation/codex/execution/${name}`);
  await expect(f.run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Builder contains private execution state") });
});
it("still refuses archived worker credentials and native history", async () => {
  const f = await fixture(); await f.file("srv/zeros/home/agent/.codex/auth.json");
  await expect(f.run()).rejects.toMatchObject({ code: 1 });
  await rm(path.join(f.root, "srv/zeros/home/agent"), { recursive: true });
  await f.file("srv/zeros/state/native-agent-history/conversation/rollout.jsonl");
  await expect(f.run()).rejects.toMatchObject({ code: 1 });
});
it("refuses an aliased physical native state root", async () => {
  const f = await fixture(); await mkdir(path.join(f.root, "srv/zeros/state"), { recursive: true });
  await symlink(path.join(f.root, "etc/zeros"), path.join(f.root, "srv/zeros/state/native-agent-homes"));
  await expect(f.run()).rejects.toMatchObject({ code: 1 });
});
