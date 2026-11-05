import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeReleaseStore } from "./runtime-storage";
import { runtimeJournal, type RuntimeEvent } from "./runtime-journal";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const sourceSha = "1".repeat(40), sourceSha256 = "a".repeat(64), sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zeros-release-store-test-")); directories.push(directory);
  const contents = join(directory, "contents"), archive = join(directory, "runtime.tar.gz"); await mkdir(contents);
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const file of ["worker.mjs", "cursor-host.mjs", "git-askpass.mjs", "gh.mjs", "bin/gh", "bin/git-askpass"]) {
    const bytes = Buffer.from(`fixture:${file}\n`), path = join(contents, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    files[file] = { sha256: sha(bytes), bytes: bytes.length };
  }
  const packages = Object.fromEntries(["@openai/codex-linux-x64", "@anthropic-ai/claude-agent-sdk-linux-x64", "@cursor/sdk-linux-x64"].map(name => [name, { name, version: "1.0.0" }]));
  await writeFile(join(contents, "runtime-manifest.json"), JSON.stringify({ version: 1, node: "24", platform: "linux", arch: "x64", packages, files }));
  await writeFile(join(contents, "BUILD.json"), JSON.stringify({ commit: sourceSha, sourceSha256, dirty: false }));
  execFileSync("tar", ["-czf", archive, "-C", contents, "."], { stdio: "pipe" });
  return { directory, archive, bytes: await readFile(archive) };
}

function storage() {
  const objects = new Map<string, Buffer>(), calls: Array<{ name: string; input: Record<string, any> }> = [];
  const client = { destroy() {}, async send(value: unknown) {
    const command = value as { constructor: { name: string }; input: Record<string, any> }, { input } = command;
    calls.push({ name: command.constructor.name, input });
    if (command.constructor.name === "GetObjectCommand") {
      const bytes = objects.get(input.Key); if (!bytes) throw Object.assign(new Error("synthetic-private-body"), { $metadata: { httpStatusCode: 404 } });
      return { ContentLength: bytes.length, Body: (async function* () { yield bytes; })() };
    }
    expect(command.constructor.name).toBe("PutObjectCommand"); expect(input.IfNoneMatch).toBe("*");
    if (objects.has(input.Key)) throw Object.assign(new Error("exists"), { $metadata: { httpStatusCode: 412 } });
    const chunks = Buffer.isBuffer(input.Body) ? [input.Body] : await Array.fromAsync(input.Body as AsyncIterable<Uint8Array>);
    const bytes = Buffer.concat(chunks); expect(bytes.length).toBe(input.ContentLength); objects.set(input.Key, bytes); return {};
  } };
  const store = runtimeReleaseStore({ endpoint: "https://storage.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" }, "example/project", { client });
  return { objects, calls, store };
}

describe("runtime release archive retention and copying", () => {
  it("publishes the checked archive by digest, retains a copy outside ordinary pruning, and retries idempotently", async () => {
    const f = await fixture(), s = storage();
    const manifest = await s.store.publish(f.archive, sourceSha, sourceSha256); expect(manifest.sha256).toBe(sha(f.bytes));
    expect(s.objects.get(`cloud-v2/runtime/${manifest.sha256}.tar.gz`)).toEqual(f.bytes);
    expect(s.objects.get(`cloud-v2/runtime/releases/archives/${manifest.sha256}.tar.gz`)).toEqual(f.bytes);
    expect(await s.store.publish(f.archive, sourceSha, sourceSha256)).toEqual(manifest);
    expect(s.calls.every(call => !call.name.startsWith("Delete"))).toBe(true);
  });
  it("copies exact Alpha bytes to the destination without rebuilding and repairs a pruned ordinary archive", async () => {
    const f = await fixture(), a = storage(), b = storage(), manifest = await a.store.publish(f.archive, sourceSha, sourceSha256);
    expect(await b.store.copy(manifest.sha256, a.store)).toEqual(manifest);
    expect(b.objects.get(`cloud-v2/runtime/${manifest.sha256}.tar.gz`)).toEqual(f.bytes);
    b.objects.delete(`cloud-v2/runtime/${manifest.sha256}.tar.gz`);
    await b.store.retain({ sha256: manifest.sha256, release: null });
    expect(b.objects.get(`cloud-v2/runtime/${manifest.sha256}.tar.gz`)).toEqual(f.bytes);
  });
  it("refuses a corrupt retained archive rather than falling back to another object", async () => {
    const f = await fixture(), a = storage(), b = storage(), manifest = await a.store.publish(f.archive, sourceSha, sourceSha256);
    a.objects.set(`cloud-v2/runtime/releases/archives/${manifest.sha256}.tar.gz`, Buffer.from("corrupt"));
    await expect(b.store.copy(manifest.sha256, a.store)).rejects.toThrow(); expect(b.objects.size).toBe(0);
  });
  it("does not publish a different source, a linked artifact, or different immutable metadata", async () => {
    const f = await fixture(), a = storage();
    await expect(a.store.publish(f.archive, "9".repeat(40), sourceSha256)).rejects.toThrow(); expect(a.objects.size).toBe(0);
    const link = join(f.directory, "linked.tar.gz"); await symlink(f.archive, link);
    await expect(a.store.publish(link, sourceSha, sourceSha256)).rejects.toThrow(); expect(a.objects.size).toBe(0);
    const manifest = await a.store.publish(f.archive, sourceSha, sourceSha256);
    a.objects.set(`cloud-v2/runtime/releases/manifests/${manifest.sha256}.json`, Buffer.from("{}"));
    await expect(a.store.publish(f.archive, sourceSha, sourceSha256)).rejects.toThrow("different bytes");
  });

  it("retains immutable credential-free recovery records and refuses fields outside their allowlist", async () => {
    const s = storage();
    const config = { channel: "alpha" as const, action: "publish" as const, repository: "example/project", workflowSha: "1".repeat(40), branch: "main",
      runId: "123", runAttempt: 1, sourceSha: "2".repeat(40), expectedCpSha: "3".repeat(40), expectedRuntimeSha256: "a".repeat(64) };
    const records: RuntimeEvent[] = [];
    const record = runtimeJournal(config, async event => { records.push(event); await s.store.saveEvent(event); });
    await record({ kind: "canary-cleanup", grantId: "11111111-1111-4111-8111-111111111111", workspaceId: null, deleted: true });
    expect([...s.objects.keys()]).toEqual(["cloud-v2/runtime/releases/intents/alpha/123/1/0001.json"]);
    await s.store.saveEvent(records[0]);
    await expect(s.store.saveEvent({ ...records[0], detail: { ...records[0].detail, password: "synthetic-private-password" } } as never)).rejects.toThrow(/details withheld/);
    await expect(s.store.saveEvent({ ...records[0], at: "2000-01-01T00:00:00.000Z" })).rejects.toThrow("different bytes");
    expect([...s.objects.values()].some(value => value.includes("synthetic-private-password"))).toBe(false);
  });
});
