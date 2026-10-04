import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cloudEngineWorkspacePaths } from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";

const require = createRequire(import.meta.url);
const engine = path.join(process.cwd(), "apps/desktop/src/engine");
// Run the production allocator, transfer, policy builder and sandbox runtime
// inside real bind mounts. No mount-ID or filesystem mocks are involved.
const probe = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createAttachmentTemporaryDirectory } from ${JSON.stringify(path.join(engine, "files/attachment-temporary-directory.ts"))};
import { transferContextAttachment } from ${JSON.stringify(path.join(engine, "files/attachment-transfer.ts"))};
import { stageContextGraphAttachment } from ${JSON.stringify(path.join(engine, "files/context-graph.ts"))};
import { prepareZsrPolicy } from ${JSON.stringify(path.join(engine, "agents/containment/policy.ts"))};
import { loadCloudWorkspacePaths } from ${JSON.stringify(path.join(engine, "agents/containment/cloud-workspace-paths.ts"))};
import { wrapCommandWithSandboxLinux } from ${JSON.stringify(require.resolve("@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js"))};
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
    await fs.rename(temporary.path + '/contents', publication + '/published.txt');
    assert.equal(await fs.readFile(workspace + '/published.txt', 'utf8'), 'complete');
  } finally { await temporary.dispose(); }
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
} else {
  process.env.ZEROS_DATA_DIR = workspace + '/private-engine';
  await fs.mkdir(process.env.ZEROS_DATA_DIR);
  await fs.writeFile(process.env.ZEROS_DATA_DIR + '/secret', 'engine-only');
  const prepared = await prepareZsrPolicy({ executionId: 'template-policy', actor: 'agent-code', cwd: workspace, workspaceRoot: workspace,
    territory: { agentRole: 'code', workspaceRoot: workspace, designDirectory: workspace + '/Design', protectedDesignDirectories: [workspace + '/Design'],
      designRecognitionPaths: [], writeCapabilities: { workspace: 'write', deniedPaths: [workspace + '/Design'] } },
    additionalReadOnlyRoots: [workspace + '/read-only', alias + '/reverse-read-only'],
    protectedWorkspaceDirectories: [workspace + '/restricted'], protectedWorkspaceWriteDirectories: [workspace + '/restricted/island'],
  }, randomUUID(), { cloudWorker: { uid: 10001, gid: 10001 } });
  const policy = prepared.document.filesystem;
  const check = \`
    const fs = require('node:fs');
    const results = {};
    for (const root of ['/srv/zeros/workspace', '/srv/zeros/repos/example/primary']) {
      for (const suffix of ['/Design/changed', '/read-only/changed', '/reverse-read-only/changed', '/restricted/changed']) {
        try { fs.writeFileSync(root + suffix, 'forbidden'); results[root + suffix] = 'writable'; }
        catch { results[root + suffix] = 'denied'; }
      }
      for (const suffix of ['/code.txt', '/restricted/island/code.txt']) {
        try { fs.writeFileSync(root + suffix, 'allowed'); results[root + suffix] = 'writable'; }
        catch { results[root + suffix] = 'denied'; }
      }
      try { results[root + '/private-engine/secret'] = fs.readFileSync(root + '/private-engine/secret', 'utf8'); }
      catch { results[root + '/private-engine/secret'] = 'denied'; }
    }
    try { fs.writeFileSync('/srv/zeros/repos/example/secondary/Design/code.txt', 'allowed'); results.secondary = 'writable'; }
    catch { results.secondary = 'denied'; }
    process.stdout.write(JSON.stringify(results));
  \`;
  const quote = word => "'" + word.replaceAll("'", "'\\\\''") + "'";
  const command = await wrapCommandWithSandboxLinux({
    command: [process.execPath, '-e', check].map(quote).join(' '), needsNetworkRestriction: false,
    hostParity: true, allowAllUnixSockets: true, disableMandatoryWriteProtection: true, bwrapPath: '/usr/bin/bwrap',
    readConfig: { denyOnly: policy.denyRead, allowWithinDeny: policy.allowRead },
    writeConfig: { allowOnly: policy.allowWrite, denyWithinAllow: policy.denyWrite,
      allowWithinDeny: policy.allowWrite.filter(candidate => policy.denyWrite.some(denied => candidate.startsWith(denied + '/'))) },
  });
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  for (const [name, value] of Object.entries(observed))
    assert.equal(value, /(?:Design|read-only|restricted)\\/changed$|private-engine\\/secret$/.test(name) ? 'denied' : 'writable', name);
  console.log('primary restrictions enforced; secondary writable');
}
`;

describe.skipIf(process.platform !== "linux")("Cloud Computer engine bind aliases", () => {
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
      const args = ["--unshare-user", "--uid", "0", "--gid", "0", "--cap-add", "CAP_SYS_ADMIN", "--die-with-parent"];
      for (const directory of ["/usr", "/home", "/opt", "/vercel", "/nix"])
        if (existsSync(directory)) args.push("--ro-bind", directory, directory);
      for (const name of ["bin", "sbin", "lib", "lib64"]) args.push("--symlink", `usr/${name}`, `/${name}`);
      args.push("--ro-bind", "/proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "--ro-bind", config, "/etc/zeros", "--ro-bind", script, "/probe.mts", "--bind", files, "/srv/zeros");
      if (template) args.push("--bind", primary, "/srv/zeros/workspace");
      args.push("--remount-ro", "/", "--", process.execPath, "--import", require.resolve("tsx"), "/probe.mts", mode, template ? "template" : "base");
      const result = spawnSync("setpriv", ["--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "bwrap", ...args], {
        encoding: "utf8", timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: "/tmp/home", ZEROS_DATA_DIR: "/tmp/state", ZEROS_ATTACHMENT_TEMP_DIR: "/srv/zeros/attachment-staging" },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  it.each([false, true])("allocates and publishes attachments on actual mounts (template: %s)", async template => {
    expect(await run("attachments", template)).toContain("attachments published");
  });
  it("enforces Code restrictions through both primary paths while keeping secondary repositories writable", async () => {
    expect(await run("policy", true)).toContain("primary restrictions enforced; secondary writable");
  });
  it.each(["different clone", "path escape", "writable marker"] as const)("refuses invalid alias admission: %s", async invalid => {
    expect(await run("invalid", true, invalid)).toContain("invalid admission rejected");
  });
});
