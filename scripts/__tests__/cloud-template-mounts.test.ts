import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { cloudEngineWorkspacePaths } from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";
import { createAttachmentTemporaryDirectory } from "../../apps/desktop/src/engine/files/attachment-temporary-directory";

const require = createRequire(import.meta.url);
const engine = path.join(process.cwd(), "apps/desktop/src/engine");
// Execute the qualification's actual publication operations. Transport is a
// fixture; both the allocator and native mount test use production code.
const qualification = ts.createSourceFile("qualify-cloud-human-services.ts", readFileSync(new URL(
  "../cloud-workspace-validation/sandbox/qualify-cloud-human-services.ts", import.meta.url,
), "utf8"), ts.ScriptTarget.Latest, true);
const humanServices = qualification.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "qualifyCloudHumanServices");
assert(humanServices?.body);
const main = humanServices.body.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "main");
assert(main?.body);
const statements = [...main.body.statements];
const phase = (node: ts.Statement, name: string) => ts.isExpressionStatement(node) &&
  ts.isBinaryExpression(node.expression) && node.expression.left.getText(qualification) === "phase" &&
  ts.isStringLiteral(node.expression.right) && node.expression.right.text === name;
const start = statements.findIndex(node => phase(node, "attachment-publication"));
const end = statements.findIndex(node => phase(node, "exec-pty"));
assert(start >= 0 && end > start);
const attachmentQualification = statements.slice(start, end).map(node => node.getText(qualification)).join("\n");

it.each([false, true])("qualifies atomic human attachment publication with a computer projection: %s", async template => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-v2-test-qualification-"));
  const workspace = "/srv/zeros/workspace", staging = "/srv/zeros/attachment-staging";
  const mapping = template ? cloudEngineWorkspacePaths("/srv/zeros/files/repos/example/primary") : null;
  const publication = mapping?.repositoryAlias ?? workspace;
  const translate = (candidate: string) => mapping && (candidate === workspace || candidate.startsWith(workspace + "/"))
    ? mapping.repositoryAlias + candidate.slice(workspace.length) : candidate;
  const physical = (candidate: string) => path.join(root, translate(candidate).slice("/srv/zeros/".length));
  const mount = (candidate: string) => template && (candidate === workspace || candidate.startsWith(workspace + "/"))
    ? "primary-bind" : "files-bind";
  const temporaries: Awaited<ReturnType<typeof createAttachmentTemporaryDirectory>>[] = [];
  const checks: string[] = [];
  let published = false;
  try {
    await mkdir(physical(workspace), { recursive: true });
    await mkdir(physical(staging), { mode: 0o700 });
    await mkdir(path.join(root, "state"));
    vi.stubEnv("ZEROS_DATA_DIR", path.join(root, "state"));
    vi.stubEnv("ZEROS_ATTACHMENT_TEMP_DIR", physical(staging));
    vi.spyOn(os, "tmpdir").mockReturnValue(physical(workspace));
    await runInNewContext(`(async () => { let temporary; ${attachmentQualification} })()`, {
      assert, checks, transfer: workspace + "/attachment",
      cloudWorkspacePublicationPath: translate,
      createAttachmentTemporaryDirectory: async (candidate: string) => {
        expect(candidate).toBe(workspace);
        const temporary = await createAttachmentTemporaryDirectory(physical(publication));
        temporaries.push(temporary);
        expect(path.dirname(temporary.path)).toBe(physical(staging));
        expect((await fs.stat(temporary.path)).mode & 0o777).toBe(0o700);
        return { ...temporary, path: staging + "/" + path.basename(temporary.path) };
      },
      writeFile: (candidate: string, contents: string, options: Parameters<typeof fs.writeFile>[2]) =>
        fs.writeFile(physical(candidate), contents, options),
      readFile: (candidate: string, encoding: BufferEncoding) => fs.readFile(physical(candidate), encoding),
      rename: async (from: string, to: string) => {
        // Linux gives distinct bind mounts distinct mount IDs despite st_dev
        // and inode equality. A logical-primary rename must fail with EXDEV.
        if (mount(from) !== mount(to)) throw Object.assign(new Error("Cross-device rename"), { code: "EXDEV" });
        await fs.rename(physical(from), physical(to));
        published = true;
      },
      rmSync: (candidate: string) => rmSync(physical(candidate)),
      exec: async (command: string) => {
        expect(command.startsWith("cat " + staging + "/")).toBe(true);
        expect((await fs.stat(path.dirname(physical(command.slice(4))))).mode & 0o777).toBe(0o700);
        return { code: 0, stdout: await fs.readFile(physical(command.slice(4)), "utf8") };
      },
    }, { timeout: 1000 });
    expect(published).toBe(true);
    expect(checks).toEqual(["shared-engine-attachment-staging", "same-mount-atomic-attachment-publication"]);
    expect(await fs.readdir(physical(staging))).toEqual([]);
    expect(await fs.readdir(physical(workspace))).toEqual([]);
  } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    for (const temporary of temporaries) await temporary.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

const nativeNamespaces = process.platform === "linux" && spawnSync("sudo", [
  "-n", "/usr/bin/bwrap", "--ro-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--", "/usr/bin/true",
], { stdio: "ignore" }).status === 0;
// Run the production allocator and transfer
// inside real bind mounts. No mount-ID or filesystem mocks are involved.
const probe = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createAttachmentTemporaryDirectory } from ${JSON.stringify(path.join(engine, "files/attachment-temporary-directory.ts"))};
import { transferContextAttachment } from ${JSON.stringify(path.join(engine, "files/attachment-transfer.ts"))};
import { stageContextGraphAttachment } from ${JSON.stringify(path.join(engine, "files/context-graph.ts"))};
import { loadCloudWorkspacePaths } from ${JSON.stringify(path.join(engine, "agents/containment/cloud-workspace-paths.ts"))};
import { cloudWorkspacePublicationPath } from ${JSON.stringify(path.join(engine, "agents/containment/cloud-workspace-paths.ts"))};
import { rmSync } from 'node:fs';
const workspace = '/srv/zeros/workspace', alias = '/srv/zeros/repos/example/primary';
await fs.mkdir('/tmp/home', { recursive: true });
const mountId = async directory => {
  const fd = await fs.open(directory);
  try { return /^mnt_id:\\s*(\\d+)$/m.exec(await fs.readFile('/proc/self/fdinfo/' + fd.fd, 'utf8'))[1]; }
  finally { await fd.close(); }
};
if (process.argv[2] === 'invalid') {
  assert.throws(() => loadCloudWorkspacePaths());
  await assert.rejects(createAttachmentTemporaryDirectory(workspace));
  console.log('invalid admission rejected');
} else if (process.argv[2] === 'attachments') {
  const template = process.argv[3] === 'template';
  const publication = template ? alias : workspace;
  if (template) assert.notEqual(await mountId(workspace), await mountId(alias));
  const temporary = await createAttachmentTemporaryDirectory(workspace);
  try {
    assert.equal(await mountId(temporary.path), await mountId(publication));
    assert(temporary.path.startsWith('/srv/zeros/attachment-staging/'));
    await fs.writeFile(temporary.path + '/contents', 'complete');
    if (template) await assert.rejects(fs.rename(temporary.path + '/contents', workspace + '/published.txt'), { code: 'EXDEV' });
    await fs.rename(temporary.path + '/contents', publication + '/published.txt');
    assert.equal(await fs.readFile(workspace + '/published.txt', 'utf8'), 'complete');
  } finally { await temporary.dispose(); }
  // The image qualification must exercise the same atomic publication as the
  // attachment services, including the separate logical-primary bind mount.
  const { writeFile, readFile, rename } = fs;
  const transfer = workspace + '/qualified.txt', checks = [];
  let phase;
  const exec = async command => { const child=spawnSync('/usr/bin/cat',[command.slice(4)],{encoding:'utf8'}); return {code:child.status,stdout:child.stdout}; };
  let qualificationTemporary;
  try {
    await (async () => { let temporary; ${attachmentQualification.replace("temporary = await createAttachmentTemporaryDirectory", "temporary = qualificationTemporary = await createAttachmentTemporaryDirectory")} })();
    assert.deepEqual(checks, ['shared-engine-attachment-staging', 'same-mount-atomic-attachment-publication']);
  } finally { await qualificationTemporary?.dispose(); }
  const common = { attachmentId: 'chunked', filename: 'upload.txt', mimeType: 'text/plain', uploadId: 'upload', totalBytes: 6 };
  assert.equal((await transferContextAttachment(workspace, { ...common, offset: 0, base64: Buffer.from('abc').toString('base64') })).pending, true);
  const saved = await transferContextAttachment(workspace, { ...common, offset: 3, base64: Buffer.from('def').toString('base64') });
  assert(saved.absolutePath.startsWith(workspace + '/'));
  assert.equal(await fs.readFile(saved.absolutePath, 'utf8'), 'abcdef');
  const inline = await stageContextGraphAttachment(workspace, { attachmentId: 'inline', filename: 'inline.txt', base64: Buffer.from('inline').toString('base64') });
  assert.equal(inline.ok, true, inline.error);
  assert.equal(await fs.readFile(inline.absolutePath, 'utf8'), 'inline');
  assert.deepEqual(await fs.readdir('/srv/zeros/attachment-staging'), []);
  console.log('attachments published');
}

`;

describe("Cloud Computer engine bind aliases", () => {
  it.skipIf(process.platform !== "linux" || !process.env.CI)("requires native namespace coverage on Linux CI", () => {
    expect(nativeNamespaces, "Run through scripts/ci/with-userns.sh with sudo and bubblewrap installed").toBe(true);
  });
  async function run(mode: string, template: boolean, invalid?: "different clone" | "path escape" | "writable marker") {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-v2-test-mounts-"));
    try {
      const files = path.join(root, "files"), config = path.join(root, "config");
      const primary = path.join(files, "repos/example/primary");
      for (const name of ["workspace", "attachment-staging", "repos/example/primary/.git", "repos/example/primary/Design",
        "repos/example/primary/read-only", "repos/example/primary/reverse-read-only", "repos/example/primary/restricted/island", "repos/example/secondary/Design"])
        await mkdir(path.join(files, name), { recursive: true });
      await mkdir(config);
      // The real launcher publishes this from the validated private admission.
      if (template) {
        const marker = cloudEngineWorkspacePaths("/srv/zeros/files/repos/example/primary");
        if (invalid === "different clone") marker.repositoryAlias = "/srv/zeros/repos/example/secondary";
        if (invalid === "path escape") marker.repositoryAlias = "/srv/zeros/repos/example/../primary";
        const file = path.join(config, "cloud-workspace-paths.json");
        await writeFile(file, JSON.stringify(marker), { mode: 0o444 });
        if (invalid === "writable marker") await chmod(file, 0o666);
      }
      await chmod(config, 0o755);
      const script = path.join(root, "probe.mts");
      await writeFile(script, probe);
      const args = ["--die-with-parent", "--unshare-pid", "--clearenv", "--setenv", "PATH", "/probe-bin:/usr/bin:/bin",
        "--setenv", "HOME", "/tmp/home", "--setenv", "ZEROS_DATA_DIR", "/tmp/state",
        "--setenv", "ZEROS_ATTACHMENT_TEMP_DIR", "/srv/zeros/attachment-staging"];
      for (const directory of ["/usr", "/home", "/opt", "/vercel", "/nix"])
        if (existsSync(directory)) args.push("--ro-bind", directory, directory);
      for (const name of ["bin", "sbin", "lib", "lib64"]) args.push("--symlink", `usr/${name}`, `/${name}`);
      // The fixture shell lookup invokes which; keep distro alternatives
      // symlinks independent of this probe's private /etc projection.
      args.push("--ro-bind", realpathSync("/usr/bin/which"), "/probe-bin/which");
      args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "--ro-bind", config, "/etc/zeros", "--ro-bind", script, "/probe.mts", "--bind", files, "/srv/zeros");
      if (template) args.push("--bind", primary, "/srv/zeros/workspace");
      args.push("--remount-ro", "/", "--", process.execPath, "--import", require.resolve("tsx"), "/probe.mts", mode, template ? "template" : "base");
      // Match the native suites: sudo owns only this disposable fixture and
      // mount namespace. Unprivileged runners cannot change the host bounding set.
      execFileSync("sudo", ["-n", "/usr/bin/chown", "-hR", "0:0", root]);
      const result = spawnSync("sudo", ["-n", "/usr/bin/bwrap", ...args], {
        encoding: "utf8", timeout: 30_000,
        env: { PATH: "/usr/bin:/bin" },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    } finally {
      execFileSync("sudo", ["-n", "/usr/bin/chown", "-hR", `${process.getuid!()}:${process.getgid!()}`, root]);
      await rm(root, { recursive: true, force: true });
    }
  }

  it.skipIf(!nativeNamespaces).each([false, true])("allocates and publishes attachments on actual mounts (template: %s)", async template => {
    expect(await run("attachments", template)).toContain("attachments published");
  });
  it.skipIf(!nativeNamespaces).each(["different clone", "path escape", "writable marker"] as const)("refuses invalid alias admission: %s", async invalid => {
    expect(await run("invalid", true, invalid)).toContain("invalid admission rejected");
  });
});
