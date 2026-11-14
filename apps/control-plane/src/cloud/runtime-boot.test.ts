import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installRuntimeCommand, prepareRuntimeCommand } from "./runtime.js";
import { deliverWorkerTokenCommand } from "./lifecycle.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zeros-runtime-boot-")); roots.push(root);
  const bin = join(root, "bin"), archives = join(root, "archives"), log = join(root, "commands");
  for (const path of [bin, archives, join(root, "etc/systemd/system"), join(root, "etc/profile.d"), join(root, "run")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, "kernel-boot"), "test-machine-boot\n");
  writeFileSync(log, "");
  writeFileSync(join(bin, "sudo"), '#!/bin/sh\n[ "$1" != -n ] || shift\n[ "$1" != chown ] || exit 0\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, "systemctl"), '#!/bin/bash\nprintf "systemctl %s\\n" "$*" >> "$ZEROS_TEST_COMMAND_LOG"\ncase "$1" in start) [ ! -e "$ZEROS_TEST_RUNNING" ] || exit 0 ;; restart|try-restart) ;; *) exit 0 ;; esac\nset -a\n[ ! -e "$ZEROS_TEST_ENV_FILE" ] || source "$ZEROS_TEST_ENV_FILE"\nset +a\nbash "$ZEROS_TEST_START_SCRIPT" && touch "$ZEROS_TEST_RUNNING"\n', { mode: 0o755 });
  writeFileSync(join(bin, "curl"), '#!/bin/bash\nprintf "download\\n" >> "$ZEROS_TEST_COMMAND_LOG"\n[ ! -e "$ZEROS_TEST_OFFLINE" ] || exit 7\nwhile [ $# -gt 0 ]; do [ "$1" != -o ] || out=$2; url=$1; shift; done\ncp "$ZEROS_TEST_ARCHIVES/${url##*/}.tar.gz" "$out"\n', { mode: 0o755 });
  const archive = (label: string) => {
    const source = join(root, label); mkdirSync(source);
    const worker = Buffer.from(`import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.ZEROS_TEST_PROCESS_LOG, JSON.stringify({ pid: process.pid, label: ${JSON.stringify(label)}, sha256: process.env.CLOUD_V2_RUNTIME_SHA256, cache: process.env.NODE_COMPILE_CACHE }) + '\\n');\n`);
    writeFileSync(join(source, "worker.mjs"), worker, { mode: 0o644 });
    writeFileSync(join(source, "runtime-manifest.json"), JSON.stringify({ version: 1, files: {
      "worker.mjs": { sha256: createHash("sha256").update(worker).digest("hex"), bytes: worker.length, mode: 0o644 },
    } }));
    const file = join(root, `${label}.tar.gz`);
    execFileSync("tar", ["-czf", file, "-C", source, "."]);
    const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
    writeFileSync(join(archives, `${sha256}.tar.gz`), readFileSync(file));
    return sha256;
  };
  const old = archive("old"), next = archive("next");
  const relocate = (command: string) => command
    .replaceAll("/opt/zeros", join(root, "opt/zeros")).replaceAll("/home/user", join(root, "home/user"))
    .replaceAll("/etc/systemd/system", join(root, "etc/systemd/system")).replaceAll("/etc/profile.d", join(root, "etc/profile.d"))
    .replaceAll("/run/zeros-worker.boot", join(root, "run/zeros-worker.boot")).replaceAll("/proc/sys/kernel/random/boot_id", join(root, "kernel-boot"));
  const run = (command: string) => execFileSync("bash", ["-c", relocate(command)], {
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      ZEROS_TEST_COMMAND_LOG: log, ZEROS_TEST_ARCHIVES: archives, ZEROS_TEST_OFFLINE: join(root, "offline"),
      ZEROS_TEST_START_SCRIPT: join(root, "opt/zeros/start-worker"), ZEROS_TEST_RUNNING: join(root, "running"),
      ZEROS_TEST_ENV_FILE: join(root, "home/user/.config/zeros/worker.env"), ZEROS_TEST_PROCESS_LOG: join(root, "processes") },
  });
  const install = (sha256: string, supportedSha256 = [sha256]) => {
    const result = run(installRuntimeCommand({ sha256, url: `https://fixture.example.test/${sha256}`, supportedSha256 }));
    const starter = join(root, "opt/zeros/start-worker");
    if (existsSync(starter)) writeFileSync(starter, relocate(readFileSync(starter, "utf8")));
    return result;
  };
  const prepare = (sha256: string) => run(prepareRuntimeCommand({ sha256, url: `https://fixture.example.test/${sha256}` }));
  const directory = (sha256: string) => join(root, "opt/zeros/runtime", sha256);
  const current = () => readlinkSync(join(root, "opt/zeros/worker"));
  const compiled = (sha256: string) => {
    const directory = join(root, "home/user/.cache/zeros/node-compile-cache", sha256);
    mkdirSync(directory, { recursive: true }); const file = join(directory, "entry"); writeFileSync(file, sha256); return file;
  };
  return { root, old, next, run, install, prepare, directory, current, compiled,
    commands: () => readFileSync(log, "utf8"), offline: () => writeFileSync(join(root, "offline"), ""),
    processes: () => existsSync(join(root, "processes")) ? readFileSync(join(root, "processes"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [] };
}

it("boots the installed supported runtime without fetching the newer target or restarting during selection", () => {
  const f = fixture(); f.install(f.old); const compiled = f.compiled(f.old), before = f.commands(); f.offline();
  expect(() => f.install(f.next, [f.next, f.old])).not.toThrow();
  expect(f.current()).toBe(f.directory(f.old));
  expect(f.commands().slice(before.length)).not.toMatch(/download|(?:try-restart|restart|stop) zeros-worker/);
  expect(readFileSync(compiled, "utf8")).toBe(f.old);
});

it("selects a prestaged supported target without a download and preserves both digests' compile caches", () => {
  const f = fixture(); f.install(f.old); const oldCache = f.compiled(f.old), nextCache = f.compiled(f.next);
  f.prepare(f.next); expect(f.current()).toBe(f.directory(f.old)); const before = f.commands(); f.offline();
  f.install(f.next, [f.next, f.old]);
  expect(f.current()).toBe(f.directory(f.next));
  expect(f.commands().slice(before.length)).not.toMatch(/download|(?:try-restart|restart|stop) zeros-worker/);
  expect(readFileSync(oldCache, "utf8")).toBe(f.old);
  expect(readFileSync(nextCache, "utf8")).toBe(f.next);
});

it.each(["archive", "worker", "extra", "manifest"])("re-verifies a completed runtime and rejects a changed %s with no network fallback", changed => {
  const f = fixture(); f.install(f.old); const directory = f.directory(f.old); f.offline();
  if (changed === "archive") writeFileSync(join(directory, ".runtime.tar.gz"), "corrupt archive");
  if (changed === "worker") writeFileSync(join(directory, "worker.mjs"), "unexpected executable");
  if (changed === "extra") writeFileSync(join(directory, "unexpected.mjs"), "unexpected executable");
  if (changed === "manifest") writeFileSync(join(directory, "runtime-manifest.json"), JSON.stringify({ version: 1, files: {} }));
  expect(() => f.install(f.old)).toThrow();
});

it("does not infer support from a completed old runtime after the release removes its digest", () => {
  const f = fixture(); f.install(f.old); f.offline(); const before = f.commands();
  expect(() => f.install(f.next)).toThrow();
  expect(f.commands().slice(before.length)).not.toMatch(/(?:try-restart|restart|start) zeros-worker/);
});

it("retains the pinned archive for start-time verification", () => {
  const f = fixture(); f.install(f.old);
  expect(existsSync(join(f.directory(f.old), ".runtime.tar.gz"))).toBe(true);
});

it.each(["current", "prestaged", "supported-fallback"])("starts one verified worker process on a %s wake, even if delivery is repeated", cohort => {
  const f = fixture(); f.install(f.old);
  if (cohort === "prestaged") f.prepare(f.next);
  f.offline();
  const selected = cohort === "prestaged" ? f.next : f.old;
  f.install(cohort === "current" ? f.old : f.next, cohort === "current" ? [f.old] : [f.next, f.old]);
  expect(f.processes()).toEqual([]);
  const delivery = deliverWorkerTokenCommand(`zw2w_${"a".repeat(43)}`, { CLOUD_V2_RUNTIME_SHA256: selected });
  f.run(delivery);
  expect(f.processes()).toEqual([expect.objectContaining({ sha256: selected,
    cache: join(f.root, "home/user/.cache/zeros/node-compile-cache", selected) })]);
  f.run(delivery);
  expect(f.processes()).toHaveLength(1);
});

it("rechecks the artifact at execution, not just during selection", () => {
  const f = fixture(); f.install(f.old);
  writeFileSync(join(f.directory(f.old), "worker.mjs"), "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.ZEROS_TEST_PROCESS_LOG, '{\"tampered\":true}\\n');\n");
  try { f.run(deliverWorkerTokenCommand(`zw2w_${"a".repeat(43)}`, { CLOUD_V2_RUNTIME_SHA256: f.old })); } catch { /* Refusal is the expected start result. */ }
  expect(f.processes()).toEqual([]);
});
