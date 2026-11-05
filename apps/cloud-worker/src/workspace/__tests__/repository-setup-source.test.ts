import { chmod, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RepositorySetupSource } from "../repository-setup";
import { WorkspaceSetup } from "../setup";
import { repositoryFixture } from "./repository-fixture";
import { ApplicationEnvironment } from "../../credentials/application-environment";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture(path = "setup.sh", content: string | Buffer = "printf committed > selected\n") {
  const f = await repositoryFixture();
  await writeFile(join(f.root, path), content);
  await f.git("add", "--", path); await f.git("commit", "-m", "setup fixture");
  const signal = new AbortController();
  return { ...f, path, signal, read: () => RepositorySetupSource.read(f.root, path, {}, signal.signal) };
}

it("binds a regular blob at HEAD despite different staged and working bytes", async () => {
  const f = await fixture();
  const head = await f.git("rev-parse", "HEAD"), blob = await f.git("rev-parse", "HEAD:setup.sh");
  await writeFile(join(f.root, f.path), "printf staged > selected\n"); await f.git("add", "setup.sh");
  await writeFile(join(f.root, f.path), "printf working > selected\n");
  const source = await f.read();
  try {
    expect(source.commit).toBe(head); expect(source.blob).toBe(blob);
    expect(source.bytes.toString("utf8")).toBe("printf committed > selected\n");
  } finally { await source.close(); }
});

it.each([
  ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
  ["NUL", Buffer.from("echo unsafe\0\n")],
  ["empty", Buffer.alloc(0)],
  ["oversize", Buffer.alloc(64 * 1024 + 1, "x")],
] as const)("refuses %s blobs with only a closed diagnostic", async (_name, content) => {
  const f = await fixture("setup.sh", content);
  await expect(f.read()).rejects.toMatchObject({ reason: "script_refused", message: "The selected repository setup script could not be admitted." });
});

it("admits a valid UTF-8 script at the exact byte bound", async () => {
  const f = await fixture("setup.sh", `#${"x".repeat(64 * 1024 - 2)}\n`), source = await f.read();
  try { expect(source.bytes.length).toBe(64 * 1024); } finally { await source.close(); }
});

it("refuses tracked symlinks and submodule entries without following their files", async () => {
  const f = await fixture();
  await symlink("setup.sh", join(f.root, "link.sh")); await f.git("add", "link.sh");
  await f.git("update-index", "--add", "--cacheinfo", `160000,${await f.git("rev-parse", "HEAD")},nested`);
  await f.git("commit", "-m", "non-regular entries");
  await mkdir(join(f.root, "nested")); await writeFile(join(f.root, "nested/setup.sh"), "echo nested\n");
  for (const path of ["link.sh", "nested", "nested/setup.sh"])
    await expect(RepositorySetupSource.read(f.root, path, {}, f.signal.signal)).rejects.toMatchObject({ reason: "script_refused" });
});

it("holds the original checkout identity and refuses a replacement root", async () => {
  const f = await fixture(), source = await f.read();
  try {
    await rename(f.root, `${f.root}-old`); await mkdir(f.root);
    expect(() => source.assertCurrent()).toThrow(expect.objectContaining({ reason: "source_changed" }));
  } finally { await source.close(); }
});

it("refuses an already-cancelled read and a retired captured source", async () => {
  const f = await fixture(), source = await f.read();
  try {
    f.signal.abort();
    expect(() => source.assertCurrent()).toThrow();
    await expect(f.read()).rejects.toMatchObject({ reason: "script_refused" });
  } finally { await source.close(); }
});

it.each(["abort", "deadline"])("cancels and joins a held native Git read on %s", async reason => {
  const f = await fixture(), bin = join(f.directory, "bin"), started = join(f.directory, "git-started");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/bash\ntrap '' TERM\nprintf '%s' $$ > '${started}'\nsleep 60\n`);
  await chmod(join(bin, "git"), 0o700);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const pending = f.read().then(source => { void source.close(); return null; }, error => error);
  try {
    await expect.poll(() => readFile(started, "utf8").catch(() => "")).not.toBe("");
    if (reason === "abort") f.signal.abort();
    expect(await pending).toMatchObject({ reason: "script_refused" });
    const pid = Number(await readFile(started, "utf8"));
    await expect(readFile(`/proc/${pid}/stat`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { f.signal.abort(); await pending; }
}, 15_000);

it("executes frozen bytes with literal Unicode, spaces and shell syntax in the selected path", async () => {
  const f = await fixture("準備 '$(touch injected)' [1].sh");
  const read = RepositorySetupSource.read;
  vi.spyOn(RepositorySetupSource, "read").mockImplementationOnce(async (...args) => {
    const source = await read(...args);
    await writeFile(join(f.root, f.path), "printf replacement > selected\n");
    return source;
  });
  const setup = new WorkspaceSetup({ directory: f.state, workspace: { ...f.scope.workspace, setupScript: f.path }, gitEnvironment: {}, activity() {} });
  try {
    setup.start(true); await expect.poll(() => setup.busy).toBe(false);
    expect(await readFile(join(f.root, "selected"), "utf8")).toBe("committed");
    await expect(readFile(join(f.root, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await setup.dispose(); }
});

it("uses app values only at execution and redacts their actual native output", async () => {
  const f = await fixture("setup.sh", "printf '%s' \"$APP_SECRET\"\n"), canary = "synthetic-selected-script-canary";
  const setup = new WorkspaceSetup({ directory: f.state, workspace: { ...f.scope.workspace, setupScript: f.path }, gitEnvironment: {},
    application: new ApplicationEnvironment({ variables: { APP_SECRET: canary }, files: [] }), activity() {} });
  try {
    setup.start(true); await expect.poll(() => setup.busy).toBe(false);
    const base = join(f.state, "workspace-setup", f.scope.workspace.id);
    expect(await readFile(`${base}.log`, "utf8")).toBe("[redacted]");
    const status = await readFile(`${base}.json`, "utf8");
    expect(status).not.toContain(canary);
    expect(status).not.toContain("printf");
    expect(JSON.parse(status)).toMatchObject({ state: "succeeded", source: { path: f.path, commit: expect.any(String), blob: expect.any(String) } });
  } finally { await setup.dispose(); }
});

it("redacts script lines echoed by native shell errors", async () => {
  const body = "if then synthetic-private-script-line\n", f = await fixture("setup.sh", body);
  const setup = new WorkspaceSetup({ directory: f.state, workspace: { ...f.scope.workspace, setupScript: f.path }, gitEnvironment: {}, activity() {} });
  try {
    setup.start(true); await expect.poll(() => setup.busy).toBe(false);
    const base = join(f.state, "workspace-setup", f.scope.workspace.id);
    const log = await readFile(`${base}.log`, "utf8");
    expect(log).toContain("syntax error");
    expect(log).not.toContain(body.trim());
    expect(JSON.parse(await readFile(`${base}.json`, "utf8"))).toMatchObject({ state: "failed" });
  } finally { await setup.dispose(); }
});
