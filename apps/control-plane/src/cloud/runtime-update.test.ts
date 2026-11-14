import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { activateRuntimeCommand, completeRuntimeCommand, prepareRuntimeCommand, pruneRuntimeCommand } from "./runtime.js";
import { deliverWorkerTokenCommand } from "./lifecycle.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zeros-runtime-update-")); roots.push(root);
  const runtimes = join(root, "opt/zeros/runtime"), bin = join(root, "bin"), source = join(root, "source");
  const old = "a".repeat(64), extra = "b".repeat(64);
  for (const path of [bin, source, join(runtimes, old), join(runtimes, extra), join(root, "home/user/.config/zeros"), join(root, "home/user/.local/share/zeros/cloud-worker"), join(root, "run")]) mkdirSync(path, { recursive: true });
  const token = `zw2w_${"a".repeat(43)}`, bootId = randomUUID();
  writeFileSync(join(root, "home/user/.config/zeros/worker-token"), token);
  writeFileSync(join(root, "home/user/.local/share/zeros/cloud-worker/runtime-boot"), bootId);
  writeFileSync(join(runtimes, old, ".complete"), "");
  writeFileSync(join(source, "worker.mjs"), "process.stdout.write('fixture');\n");
  const worker = readFileSync(join(source, "worker.mjs"));
  writeFileSync(join(source, "runtime-manifest.json"), JSON.stringify({ version: 1, files: {
    "worker.mjs": { sha256: createHash("sha256").update(worker).digest("hex"), bytes: worker.length, mode: 0o644 },
  } }));
  const archive = join(root, "runtime.tar.gz"); execFileSync("tar", ["-czf", archive, "-C", source, "."]);
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const current = join(root, "opt/zeros/worker"); symlinkSync(join(runtimes, old), current);
  const auth = join(root, "opt/zeros/worker-auth.json"); writeFileSync(auth, "fixture verification material");
  const log = join(root, "systemctl.log"); writeFileSync(log, "");
  writeFileSync(join(bin, "sudo"), '#!/bin/sh\n[ "$1" != "-n" ] || shift\n[ "$1" != "chown" ] || exit 0\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, "curl"), '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$ZEROS_TEST_ARCHIVE" "$2"\n', { mode: 0o755 });
  writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ZEROS_TEST_SYSTEMCTL_LOG"\n', { mode: 0o755 });
  const run = (command: string) => execFileSync("bash", ["-c", command.replaceAll("/opt/zeros", join(root, "opt/zeros")).replaceAll("/home/user", join(root, "home/user")).replaceAll("/run/zeros-worker.boot", join(root, "run/zeros-worker.boot"))], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZEROS_TEST_SYSTEMCTL_LOG: log, ZEROS_TEST_ARCHIVE: archive }, stdio: ["ignore", "pipe", "pipe"],
  });
  const permit = (id: string) => {
    const directory = join(root, "home/user/.local/share/zeros/cloud-worker/runtime-handoffs"); mkdirSync(directory, { recursive: true });
    const path = join(directory, `permit-${id}-${bootId}`); writeFileSync(path, "", { flag: "wx", mode: 0o600 }); return path;
  };
  const runAsync = (command: string, env: NodeJS.ProcessEnv) => promisify(execFile)("bash", ["-c", command.replaceAll("/opt/zeros", join(root, "opt/zeros")).replaceAll("/home/user", join(root, "home/user")).replaceAll("/run/zeros-worker.boot", join(root, "run/zeros-worker.boot"))], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZEROS_TEST_SYSTEMCTL_LOG: log, ZEROS_TEST_ARCHIVE: archive, ...env }, timeout: 10_000,
  });
  return { root, bin, runtimes, sha256, old, extra, current, auth, log, archive, run, runAsync, permit, bootId, tokenSha256: createHash("sha256").update(token).digest("hex") };
}

it("verifies and stages bytes without activation, then activates once and retains the previous cache", () => {
  const f = fixture();
  const compiled = join(f.root, "home/user/.cache/zeros/node-compile-cache/v24-x64-tag-1000/entry");
  mkdirSync(dirname(compiled), { recursive: true }); writeFileSync(compiled, "previous runtime");
  f.run(prepareRuntimeCommand({ sha256: f.sha256, url: "https://fixture.example.test/runtime.tar.gz" }));
  expect(readFileSync(compiled, "utf8")).toBe("previous runtime");
  expect(readlinkSync(f.current)).toBe(join(f.runtimes, f.old));
  expect(readFileSync(f.auth, "utf8")).toBe("fixture verification material");
  expect(readFileSync(f.log, "utf8")).toBe("");
  expect(readFileSync(join(f.runtimes, f.sha256, "worker.mjs"), "utf8")).toContain("fixture");
  const id = randomUUID(); f.permit(id);
  const activation = { sha256: f.sha256, previousSha256: f.old, id, bootId: randomUUID(), instanceId: randomUUID(), tokenSha256: f.tokenSha256 };
  const command = activateRuntimeCommand({ ...activation, expectedBootIds: [f.bootId] });
  f.run(command);
  expect(readFileSync(compiled, "utf8")).toBe("previous runtime");
  mkdirSync(dirname(compiled), { recursive: true }); writeFileSync(compiled, "current runtime");
  f.run(command);
  expect(readlinkSync(f.current)).toBe(join(f.runtimes, f.sha256));
  expect(readFileSync(f.log, "utf8")).toBe("restart zeros-worker.service\n");
  f.run(pruneRuntimeCommand(f.sha256, f.old));
  expect(existsSync(join(f.runtimes, f.old))).toBe(true);
  expect(existsSync(join(f.runtimes, f.extra))).toBe(false);
  f.run(completeRuntimeCommand(activation)); f.run(completeRuntimeCommand(activation));
  expect(readFileSync(join(f.root, "opt/zeros/worker-runtime.env"), "utf8")).toBe(`CLOUD_V2_RUNTIME_SHA256=${f.sha256}\n`);
  expect(readFileSync(join(f.root, "home/user/.local/share/zeros/cloud-worker/runtime-handoffs", `completed-${id}-${activation.bootId}`), "utf8")).toBe("");
  expect(readFileSync(f.log, "utf8")).toBe("restart zeros-worker.service\n");
  expect(readFileSync(compiled, "utf8")).toBe("current runtime");
});

it("refuses a delayed activation when Stop withdrew its permit during the final preparation await", async () => {
  const f = fixture(), id = randomUUID(), permit = f.permit(id);
  f.run(prepareRuntimeCommand({ sha256: f.sha256, url: "https://fixture.example.test/runtime.tar.gz" }));
  const held = join(f.root, "held"), entered = join(f.root, "entered"); execFileSync("mkfifo", [held]);
  writeFileSync(join(f.bin, "sudo"), `#!/bin/sh\n[ "$1" != "-n" ] || shift\n[ "$1" != "chown" ] || exit 0\nif [ "$1" = "chmod" ] && [ "$3" = "$ZEROS_TEST_NEXT_ENV" ]; then touch "$ZEROS_TEST_ENTERED"; read release < "$ZEROS_TEST_HELD"; fi\nexec "$@"\n`, { mode: 0o755 });
  const command = activateRuntimeCommand({ sha256: f.sha256, previousSha256: f.old, id, bootId: randomUUID(), instanceId: randomUUID(),
    tokenSha256: f.tokenSha256, expectedBootIds: [f.bootId] });
  const task = f.runAsync(command, { ZEROS_TEST_NEXT_ENV: join(f.root, "opt/zeros/worker-runtime.env.next"), ZEROS_TEST_ENTERED: entered, ZEROS_TEST_HELD: held })
    .then(result => result, error => ({ stdout: error.stdout, stderr: error.stderr }));
  try {
    await expect.poll(() => existsSync(entered)).toBe(true);
    expect(readlinkSync(f.current)).toBe(join(f.runtimes, f.old));
    rmSync(permit);
  } finally { writeFileSync(held, "release\n"); }
  await task;
  expect(readlinkSync(f.current)).toBe(join(f.runtimes, f.old));
  expect(readFileSync(f.log, "utf8")).toBe("");
});

it("refuses a corrupt archive without changing the active runtime", () => {
  const f = fixture(); writeFileSync(f.archive, "corrupt fixture");
  expect(() => f.run(prepareRuntimeCommand({ sha256: f.sha256, url: "https://fixture.example.test/runtime.tar.gz" }))).toThrow();
  expect(existsSync(join(f.runtimes, f.sha256, ".complete"))).toBe(false);
  expect(readlinkSync(f.current)).toBe(join(f.runtimes, f.old));
  expect(readFileSync(f.log, "utf8")).toBe("");
});

it("a natural token delivery clears the private override and fences a delayed old activation", () => {
  const f = fixture(), id = randomUUID(); f.permit(id);
  f.run(prepareRuntimeCommand({ sha256: f.sha256, url: "https://fixture.example.test/runtime.tar.gz" }));
  const next = `zw2w_${"b".repeat(43)}`;
  writeFileSync(join(f.root, "opt/zeros/worker-runtime.env"), "stale private override");
  f.run(deliverWorkerTokenCommand(next, { CLOUD_V2_RUNTIME_SHA256: f.old }));
  expect(existsSync(join(f.root, "opt/zeros/worker-runtime.env"))).toBe(false);
  expect(() => f.run(activateRuntimeCommand({ sha256: f.sha256, previousSha256: f.old, id, bootId: randomUUID(), instanceId: randomUUID(),
    tokenSha256: f.tokenSha256, expectedBootIds: [f.bootId] }))).toThrow();
  expect(readlinkSync(f.current)).toBe(join(f.runtimes, f.old));
  expect(readFileSync(f.log, "utf8")).toBe("is-enabled --quiet zeros-worker.service\nstart zeros-worker.service\n");
});
