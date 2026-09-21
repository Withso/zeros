import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudWorkspaceDurabilityRuntime } from "../../apps/desktop/src/engine/cloud-durability-runtime";
import { prepareRepositoryAndSettings, restoreCloudWorkspaceCheckpoint } from "../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs";

// This suite exercises real setpriv/chown and setup's fixed Linux deployment
// layout. It requires an explicit disposable-root test invocation; never run it
// on an installed workspace or let the fixture replace an existing /srv/zeros.
describe.runIf(process.platform === "linux" && process.getuid?.() === 0 && process.env.ZEROS_RUN_ROOT_FIXTURES === "1")("cloud checkpoint HTTP recovery under the worker identity", () => {
  let root = ""; let ownsRuntime = false; let server: Server | undefined;
  beforeAll(async () => {
    await fs.mkdir("/srv/zeros", { mode: 0o755 }); ownsRuntime = true;
    root = await fs.mkdtemp(path.join(tmpdir(), "zeros-root-recovery-")); await fs.chmod(root, 0o755);
    for (const directory of ["/srv/zeros/home/agent", "/srv/zeros/state"]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o755 }); await fs.chown(directory, 10001, 10001);
    }
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    if (root) await fs.rm(root, { recursive: true, force: true });
    if (ownsRuntime) await fs.rm("/srv/zeros", { recursive: true, force: true });
  });
  const git = (cwd: string, args: string[], worker = false) => execFileSync(worker ? "/usr/bin/setpriv" : "/usr/bin/git",
    worker ? ["--reuid=10001", "--regid=10001", "--clear-groups", "/usr/bin/git", ...args] : args,
    { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: "/srv/zeros/home/agent" } }).trim();

  it("preserves user commits on wake and accepts a restored HEAD beyond the checkout pin", async () => {
    const repository = "/srv/zeros/workspace";
    await fs.mkdir(repository); git(repository, ["init", "-q"]);
    git(repository, ["config", "user.name", "Recovery"]); git(repository, ["config", "user.email", "recovery@example.test"]);
    git(repository, ["remote", "add", "origin", "https://github.com/example/recovery.git"]);
    await fs.writeFile(path.join(repository, "file.txt"), "base\n"); git(repository, ["add", "."]); git(repository, ["commit", "-qm", "base"]);
    const base = git(repository, ["rev-parse", "HEAD"]); execFileSync("chown", ["-R", "10001:10001", repository]);
    // This is the root-owned seed backup installed by the atomic clone path.
    await fs.mkdir("/srv/zeros/.zeros-image-seed");
    const profile = { version: 1, setupDirectory: "/srv/zeros/setup", managedSettingsDirectory: "/srv/zeros/managed" };
    const material = { execution: { workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, setupRunId: randomUUID(), executionFence: 1 },
      repository: { cloneUrl: "https://github.com/example/recovery.git", revision: base }, settings: { version: 1, snapshotSha256: "a".repeat(64), document: { values: {} }, setupCommands: [], setupEnvironment: [] } };
    const stringify = async () => "[env]\nQUALIFICATION = \"true\"\n";
    expect(await prepareRepositoryAndSettings(material, profile, stringify)).toBe(base);
    await fs.writeFile(path.join(repository, "file.txt"), "user commit\n");
    git(repository, ["commit", "-qam", "unpublished"], true); const head = git(repository, ["rev-parse", "HEAD"], true);
    await expect(prepareRepositoryAndSettings(material, profile, stringify)).resolves.toBe(head);
    const journalPath = "/srv/zeros/setup/repository.json";
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    await fs.writeFile(journalPath, JSON.stringify({ ...journal, repository: { ...journal.repository, commit: base } }));
    await expect(prepareRepositoryAndSettings({ ...material, settings: { ...material.settings, setupCommands: [{ command: "true", timeoutSeconds: 1 }] } }, profile, stringify)).rejects.toMatchObject({ code: "repository_revision_invalid" });
    await fs.unlink(journalPath);
    await expect(prepareRepositoryAndSettings({ ...material, recovery: { checkpointId: randomUUID() } }, profile, stringify)).resolves.toBe(head);
  });

  it("restores the full working tree, index, unpublished HEAD, attachments, Design selection and histories through HTTP", async () => {
    const source = path.join(root, "source"); await fs.mkdir(source);
    const home = path.join(root, "source-home"); const data = path.join(root, "source-data");
    await fs.mkdir(home); await fs.mkdir(data);
    git(source, ["init", "-q"]); git(source, ["config", "user.name", "Recovery"]); git(source, ["config", "user.email", "recovery@example.test"]);
    await fs.writeFile(path.join(source, ".gitignore"), ".context/\n.zeros/\n.env\n");
    await fs.writeFile(path.join(source, "file.txt"), "base\n"); await fs.writeFile(path.join(source, "obsolete.txt"), "old\n");
    git(source, ["add", "."]); git(source, ["commit", "-qm", "base"]); const base = git(source, ["rev-parse", "HEAD"]);
    await fs.unlink(path.join(source, "obsolete.txt")); await fs.writeFile(path.join(source, "new.txt"), "unpublished\n");
    git(source, ["add", "-A"]); git(source, ["commit", "-qm", "unpublished"]); const head = git(source, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(source, "file.txt"), "staged\n"); git(source, ["add", "file.txt"]);
    await fs.writeFile(path.join(source, "file.txt"), "unstaged\n");
    await fs.writeFile(path.join(source, "AD.txt"), "stage then remove\n"); git(source, ["add", "AD.txt"]); await fs.unlink(path.join(source, "AD.txt"));
    await fs.writeFile(path.join(source, "untracked.txt"), "receive me\n");
    await fs.symlink("file.txt", path.join(source, "link.txt"));
    await fs.mkdir(path.join(source, ".zeros"));
    await fs.writeFile(path.join(source, ".zeros/settings.local.toml"), '[design]\ndirectory_id = "design_test"\n[env]\nSUBSCRIPTION_SECRET = "do-not-copy"\n');
    await fs.mkdir(path.join(source, ".context/attachments"), { recursive: true });
    await fs.writeFile(path.join(source, ".context/attachments/image.txt"), "attachment payload");
    const key = createHash("sha256").update("/srv/zeros/workspace").digest("hex");
    for (const [relative, text] of [
      [".codex/sessions/2026/09/19/rollout-test.jsonl", "codex history\n"],
      [".claude/projects/-srv-zeros-workspace/session.jsonl", "claude history\n"],
      [`.cursor/zeros-workspaces/${key}/agents.ndjson`, "cursor history\n"],
      [".codex/auth.json", "credential excluded"],
    ]) { await fs.mkdir(path.dirname(path.join(home, relative!)), { recursive: true }); await fs.writeFile(path.join(home, relative!), text!); }
    const design = path.join(data, "design-storage", key.slice(0, 32)); await fs.mkdir(design, { recursive: true });
    await fs.writeFile(path.join(design, "registry.json"), '{"retained":true}');

    const blobs = new Map<string, Buffer>(); const blobHashes = new Map<string, string>();
    const entries = new Map<string, Record<string, unknown>>(); let revision = 0;
    let committed: { artifactBlobIds: string[]; manifestBlobId: string; fileCount: number; totalBytes: number } | undefined;
    const checkpointId = randomUUID(); const authority = { heartbeatEndpoint: "https://control.example.test/internal/heartbeat", heartbeatToken: "test-heartbeat",
      workspaceId: randomUUID(), organizationId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
    const runtime = new CloudWorkspaceDurabilityRuntime(source, { nativeRoots: { agentHome: home, data, logicalRepository: "/srv/zeros/workspace" }, fetch: async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/content/head")) return Response.json({ currentRevision: revision, durableRevision: 0, checkpointId: null, entries: [], nextAfterPath: null });
      if (pathname.endsWith("/blobs")) {
        const bytes = Buffer.from(init!.body as Uint8Array); const sha = createHash("sha256").update(bytes).digest("hex");
        const id = blobHashes.get(sha) ?? randomUUID(); blobs.set(id, bytes); blobHashes.set(sha, id);
        return Response.json({ id, plaintextSha256: sha, sizeBytes: bytes.length });
      }
      const body = JSON.parse(String(init?.body));
      if (pathname.endsWith("/blobs/batch")) {
        return Response.json({ blobs: body.entries.map((entry: { bytesBase64: string }, index: number) => {
          const bytes = Buffer.from(entry.bytesBase64, "base64"), sha = createHash("sha256").update(bytes).digest("hex");
          const id = blobHashes.get(sha) ?? randomUUID(); blobs.set(id, bytes); blobHashes.set(sha, id);
          return { index, id, plaintextSha256: sha, sizeBytes: bytes.length, reused: false };
        }) });
      }
      if (pathname.endsWith("/content/append")) {
        expect(body.expectedRevision).toBe(revision); for (const entry of body.mutations) entries.set(entry.path, entry);
        return Response.json({ revision: ++revision, replayed: false });
      }
      if (pathname.endsWith("/checkpoints/commit")) { committed = body; return Response.json({ checkpointId, contentRevision: revision, replayed: false }); }
      throw new Error("unexpected checkpoint request");
    } });
    await runtime.checkpoint({ id: randomUUID(), reason: "before_rebuild", deadlineAtMs: Date.now() + 30_000 }, authority);
    expect(committed?.artifactBlobIds.length).toBeGreaterThan(0);
    const descriptor = (blobId: string) => ({ blobId, contentSha256: createHash("sha256").update(blobs.get(blobId)!).digest("hex"), sizeBytes: blobs.get(blobId)!.length });
    const recovery = { version: 1, audience: "zeros-cloud-workspace-recovery-v1", checkpointId, contentRevision: revision, recordRevision: 1,
      endpoint: "", token: `zrc_${"t".repeat(43)}`, expiresAtMs: Date.now() + 30_000 };
    let corruptNative = true, holdManifest = false;
    let manifestRequested: (() => void) | undefined;
    server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${recovery.token}`) { response.writeHead(401); response.end(); return; }
      if (new URL(request.url!, "http://localhost").pathname.endsWith("/manifest")) {
        if (holdManifest) {
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"version":2,'); manifestRequested?.(); return;
        }
        const document = JSON.parse(blobs.get(committed!.manifestBlobId)!.toString());
        const body = Buffer.from(JSON.stringify({ version: 2, audience: "zeros-cloud-workspace-recovery-manifest-v2", checkpointId, contentRevision: revision,
          gitBaseCommit: head, gitHeadRef: document.gitHeadRef, fileCount: committed!.fileCount, totalBytes: committed!.totalBytes,
          entries: [...entries.values()].sort((a, b) => Buffer.compare(Buffer.from(String(a.path)), Buffer.from(String(b.path)))), nextAfterPath: null,
          manifest: descriptor(committed!.manifestBlobId), artifacts: committed!.artifactBlobIds.map(descriptor) }));
        response.writeHead(200, { "content-type": "application/json", "content-length": body.length }); response.end(body); return;
      }
      const bytes = blobs.get(request.url!.split("/").at(-1)!);
      if (!bytes) { response.writeHead(404); response.end(); return; }
      const payload = corruptNative && request.url!.endsWith(committed!.artifactBlobIds[0]) ? Buffer.alloc(bytes.length, 0xff) : bytes;
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length }); response.end(payload);
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    recovery.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/recovery`;
    const restored = path.join(root, "restored"); await fs.mkdir(restored); git(restored, ["init", "-q"]);
    const cloneUrl = "https://github.com/example/recovery.git"; git(restored, ["remote", "add", "origin", cloneUrl]);
    await fs.writeFile(path.join(restored, "obsolete.txt"), "stale remote baseline");
    execFileSync("chown", ["-R", "10001:10001", restored]);
    holdManifest = true;
    const requested = new Promise<void>(resolve => { manifestRequested = resolve; });
    const expiring = restoreCloudWorkspaceCheckpoint({ recovery: { ...recovery, expiresAtMs: Date.now() + 150 }, repository: { cloneUrl, revision: base } }, restored);
    const rejected = expect(expiring).rejects.toMatchObject({ code: "checkpoint_restore_unavailable" });
    await requested; await rejected;
    expect(await fs.readFile(path.join(restored, "obsolete.txt"), "utf8")).toBe("stale remote baseline");
    holdManifest = false;
    await expect(restoreCloudWorkspaceCheckpoint({ recovery, repository: { cloneUrl, revision: base } }, restored)).rejects.toMatchObject({ code: "checkpoint_restore_invalid" });
    expect(await fs.readFile(path.join(restored, "obsolete.txt"), "utf8")).toBe("stale remote baseline");
    expect(await fs.readdir(root)).not.toContain(expect.stringMatching(/^\.zeros-recovery-/));
    corruptNative = false;
    await expect(restoreCloudWorkspaceCheckpoint({ recovery, repository: { cloneUrl, revision: base } }, restored)).resolves.toBe(true);
    expect(git(restored, ["rev-parse", "HEAD"], true)).toBe(head);
    expect(git(restored, ["status", "--porcelain=v1"], true)).toBe(git(source, ["status", "--porcelain=v1"]));
    expect(git(restored, ["show", ":file.txt"], true)).toBe("staged");
    expect(await fs.readFile(path.join(restored, "file.txt"), "utf8")).toBe("unstaged\n");
    await expect(fs.stat(path.join(restored, "obsolete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(restored, ".zeros/settings.local.toml"), "utf8")).toBe('[design]\ndirectory_id = "design_test"\n');
    expect(await fs.readFile(path.join(restored, ".context/attachments/image.txt"), "utf8")).toBe("attachment payload");
    expect(await fs.readFile(`/srv/zeros/state/design-storage/${key.slice(0, 32)}/registry.json`, "utf8")).toContain("retained");
    for (const relative of [".codex/sessions/2026/09/19/rollout-test.jsonl", ".claude/projects/-srv-zeros-workspace/session.jsonl", `.cursor/zeros-workspaces/${key}/agents.ndjson`]) {
      const file = `/srv/zeros/home/agent/${relative}`; expect((await fs.stat(file)).uid).toBe(10001);
      expect(execFileSync("/usr/bin/setpriv", ["--reuid=10001", "--regid=10001", "--clear-groups", "/usr/bin/cat", file], { encoding: "utf8" })).toContain("history");
    }
    await expect(fs.stat("/srv/zeros/home/agent/.codex/auth.json")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
