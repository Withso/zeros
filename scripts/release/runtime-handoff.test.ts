import { fork } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRuntimeHandoff, writeRuntimeHandoff } from "./runtime-handoff";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-private-cleanup-")); roots.push(root);
  const temporary = join(root, "temporary"), workspace = join(root, "workspace");
  await mkdir(temporary); await mkdir(workspace);
  const config = { channel: "alpha" as const, action: "publish" as const, repository: "example/project", workflowSha: "1".repeat(40), branch: "main",
    runId: "123", runAttempt: 2, sourceSha: "2".repeat(40), expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64) };
  const env = { RUNNER_ENVIRONMENT: "github-hosted", RUNNER_TEMP: temporary, GITHUB_WORKSPACE: workspace, PLANETSCALE_SERVICE_TOKEN: "synthetic-service-secret" };
  const login = { id: "role1", name: "zeros-alpha-runtime-123-2", username: "fixture.route1", password: "synthetic-login-password", access_host_url: "fixture.pg.psdb.cloud" };
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString(), directory = join(temporary, "zeros-runtime-cleanup-123-2"), path = join(directory, "login.json");
  const mask = vi.fn();
  return { root, temporary, workspace, config, env, login, expiresAt, directory, path, mask,
    write: () => writeRuntimeHandoff(config, env, login, expiresAt, mask),
    consume: <T>(use: Parameters<typeof withRuntimeHandoff<T>>[2]) => withRuntimeHandoff(config, env, use, mask) };
}

describe.skipIf(process.platform !== "linux")("same-job runtime cleanup login", () => {
  it("waits for password masking to be flushed before the credential file exists", async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { entered = resolve; });
    const writing = writeRuntimeHandoff(f.config, f.env, f.login, f.expiresAt, () => { entered(); return held; });
    await observed;
    try { await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" }); }
    finally { release(); await writing; }
    expect(JSON.parse(await readFile(f.path, "utf8")).login.id).toBe(f.login.id);
    await f.consume(async () => {});
  });
  it("masks before writing an exclusive private file outside the artifact checkout", async () => {
    const f = await fixture();
    f.mask.mockImplementation(() => { expect(f.mask).toHaveBeenCalledOnce(); });
    await f.write();
    expect(f.mask).toHaveBeenCalledExactlyOnceWith(f.login.password);
    const directory = await open(f.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { expect((await directory.stat()).mode & 0o777).toBe(0o700); } finally { await directory.close(); }
    expect(await readdir(f.workspace)).toEqual([]);
    const file = await open(f.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let saved: unknown;
    try {
      expect((await file.stat()).mode & 0o777).toBe(0o600);
      saved = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
    expect(saved).toEqual({ version: 1, source: f.config, login: f.login, expiresAt: f.expiresAt });
    expect(JSON.stringify(saved)).not.toContain(f.env.PLANETSCALE_SERVICE_TOKEN);
    f.mask.mockReset();
    expect(await f.consume(async value => value?.login.id)).toBe(f.login.id);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["self-hosted", "checkout"])("refuses a %s handoff before writing or masking a credential", async change => {
    const f = await fixture();
    if (change === "self-hosted") f.env.RUNNER_ENVIRONMENT = "self-hosted";
    else f.env.RUNNER_TEMP = f.workspace;
    await expect(f.write()).rejects.toThrow(/details withheld/);
    expect(f.mask).not.toHaveBeenCalled(); expect(await readdir(f.temporary)).toEqual([]); expect(await readdir(f.workspace)).toEqual([]);
  });
  it("never overwrites or removes a pre-existing same-attempt handoff", async () => {
    const f = await fixture(); await f.write(); const original = await readFile(f.path);
    await expect(f.write()).rejects.toThrow(/details withheld/); expect(await readFile(f.path)).toEqual(original);
  });
  it.each(["source", "password-field", "mode", "directory-mode", "hardlink", "syntax"])("removes its private file when %s validation refuses cleanup", async change => {
    const f = await fixture(); await f.write(); const use = vi.fn();
    if (change === "mode") await chmod(f.path, 0o644);
    else if (change === "directory-mode") await chmod(f.directory, 0o755);
    else if (change === "hardlink") await link(f.path, join(f.root, "extra-link"));
    else if (change === "syntax") await writeFile(f.path, "invalid-json");
    else {
      const value = JSON.parse(await readFile(f.path, "utf8"));
      if (change === "source") value.source.workflowSha = "9".repeat(40);
      else value.serviceToken = "forbidden-synthetic-secret";
      await writeFile(f.path, JSON.stringify(value));
    }
    await expect(f.consume(use)).rejects.toThrow(/details withheld/); expect(use).not.toHaveBeenCalled();
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("unlinks a substituted symlink without opening or deleting its target", async () => {
    const f = await fixture(); await f.write(); const foreign = join(f.root, "foreign"); await writeFile(foreign, "preserve");
    await unlink(f.path); await symlink(foreign, f.path);
    await expect(f.consume(vi.fn())).rejects.toThrow(/details withheld/);
    expect(await readFile(foreign, "utf8")).toBe("preserve"); await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("unlinks the login on a failed cleanup and reports a fixed error without private values", async () => {
    const f = await fixture(); await f.write();
    await expect(f.consume(async () => { throw new Error(f.login.password + f.path); })).rejects.toThrow(/^Runtime private cleanup handoff is unavailable or invalid; details withheld$/);
    await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("recovers the same acknowledged login after the creating native process is killed", async () => {
    const f = await fixture(), script = join(f.root, "interrupted.ts");
    const module = fileURLToPath(new URL("./runtime-handoff.ts", import.meta.url));
    await writeFile(script, `import { writeRuntimeHandoff } from ${JSON.stringify(module)};\n` +
      `void writeRuntimeHandoff(${JSON.stringify(f.config)}, ${JSON.stringify(f.env)}, ${JSON.stringify(f.login)}, ${JSON.stringify(f.expiresAt)}, () => {}).then(() => { process.send?.('ready'); setInterval(() => {}, 1000); });\n`);
    const child = fork(script, [], { execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")], silent: true });
    try {
      expect((await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("Fixture exited before handoff"); })]))[0]).toBe("ready");
      const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
      const retired: string[] = [];
      await f.consume(async value => { expect(value?.source).toEqual(f.config); retired.push(value!.login.id); });
      expect(retired).toEqual([f.login.id]); await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; } }
  });
});
