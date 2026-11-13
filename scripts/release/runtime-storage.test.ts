import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeReleaseStore } from "./runtime-storage";
import { runtimeJournal, type RuntimeEvent } from "./runtime-journal";
import { activeRuntimeQualification, readRuntimeCapabilities, runtimeCapabilitiesKey } from "../../apps/control-plane/src/cloud/runtime-capabilities";
import * as runtimeSource from "../../apps/control-plane/src/cloud/runtime-source";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const sourceSha = "1".repeat(40), sourceSha256 = "a".repeat(64), sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const features = ["acting-user-v1", "sync-context-v1"];
async function fixture(capabilities = true) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-release-store-test-")); directories.push(directory);
  const contents = join(directory, "contents"), archive = join(directory, "runtime.tar.gz"); await mkdir(contents);
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const file of ["worker.mjs", "cursor-host.mjs", "git-askpass.mjs", "gh.mjs", "bin/gh", "bin/git-askpass"]) {
    const bytes = Buffer.from(`fixture:${file}\n`), path = join(contents, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    files[file] = { sha256: sha(bytes), bytes: bytes.length };
  }
  if (capabilities) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, features }));
    await writeFile(join(contents, "worker-capabilities.json"), bytes);
    files["worker-capabilities.json"] = { sha256: sha(bytes), bytes: bytes.length };
  }
  const packages = Object.fromEntries(["@openai/codex-linux-x64", "@anthropic-ai/claude-agent-sdk-linux-x64", "@cursor/sdk-linux-x64"].map(name => [name, { name, version: "1.0.0" }]));
  await writeFile(join(contents, "runtime-manifest.json"), JSON.stringify({ version: 1, node: "24", platform: "linux", arch: "x64", packages, files }));
  await writeFile(join(contents, "BUILD.json"), JSON.stringify({ commit: sourceSha, sourceSha256, dirty: false }));
  execFileSync("tar", ["-czf", archive, "-C", contents, "."], { stdio: "pipe" });
  return { directory, archive, bytes: await readFile(archive) };
}

function storage(capabilitiesRead?: "missing" | "incomplete") {
  const objects = new Map<string, Buffer>(), calls: Array<{ name: string; input: Record<string, any> }> = [];
  const client = { destroy() {}, async send(value: unknown) {
    const command = value as { constructor: { name: string }; input: Record<string, any> }, { input } = command;
    calls.push({ name: command.constructor.name, input });
    if (command.constructor.name === "HeadObjectCommand") {
      const bytes = objects.get(input.Key); if (!bytes) throw { $metadata: { httpStatusCode: 404 } };
      return { ContentLength: bytes.length };
    }
    if (command.constructor.name === "GetObjectCommand") {
      const bytes = objects.get(input.Key); if (!bytes) throw Object.assign(new Error("synthetic-private-body"), { $metadata: { httpStatusCode: 404 } });
      if (input.Key.includes("/capabilities/")) {
        if (capabilitiesRead === "missing") throw { $metadata: { httpStatusCode: 404 } };
        if (capabilitiesRead === "incomplete") {
          const reply = Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), features: [features[0]] }));
          return { ContentLength: reply.length, Body: (async function* () { yield reply; })() };
        }
      }
      return { ContentLength: bytes.length, Body: (async function* () { yield bytes; })() };
    }
    expect(command.constructor.name).toBe("PutObjectCommand"); expect(input.IfNoneMatch).toBe("*");
    if (objects.has(input.Key)) throw Object.assign(new Error("exists"), { $metadata: { httpStatusCode: 412 } });
    const chunks = Buffer.isBuffer(input.Body) ? [input.Body] : await Array.fromAsync(input.Body as AsyncIterable<Uint8Array>);
    const bytes = Buffer.concat(chunks); expect(bytes.length).toBe(input.ContentLength); objects.set(input.Key, bytes); return {};
  } };
  const config = { endpoint: "https://storage.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" };
  const store = runtimeReleaseStore(config, "example/project", { client });
  return { objects, calls, store, client, config };
}

describe("runtime release archive retention and copying", () => {
  it("publishes the archive's capability record for the control plane before returning its manifest", async () => {
    const f = await fixture(), s = storage(), manifest = await s.store.publish(f.archive, sourceSha, sourceSha256);
    const expected = { version: 1, sha256: manifest.sha256, sourceSha256, commit: sourceSha, features };
    expect(s.objects.get(runtimeCapabilitiesKey(manifest.sha256))?.toString()).toBe(JSON.stringify(expected));
    const read = s.calls.findIndex(call => call.name === "GetObjectCommand" && call.input.Key === runtimeCapabilitiesKey(manifest.sha256));
    expect(read).toBeGreaterThan(-1);
    expect(s.calls.findIndex(call => call.name === "PutObjectCommand" && call.input.Key.includes("/manifests/"))).toBeGreaterThan(read);
    expect(await readRuntimeCapabilities(manifest.sha256, s.config, s.client)).toEqual(expected);
    vi.spyOn(runtimeSource, "runtimeStorageClient").mockReturnValue(s.client as never);
    const release = { version: 1 as const, sha256: manifest.sha256, sourceSha256, sourceSha,
      qualification: { channel: "alpha" as const, runId: "123", runAttempt: 1, completedAt: "2026-01-01T00:00:00Z", receiptSha256: "d".repeat(64), deleted: true as const } };
    expect(await activeRuntimeQualification("alpha", { sha256: manifest.sha256, release, store: s.config })()).toEqual(expected);
  });

  it("ensures the missing capability record when the immutable archive was already published", async () => {
    const f = await fixture(), s = storage(), digest = sha(f.bytes);
    s.objects.set(`cloud-v2/runtime/${digest}.tar.gz`, f.bytes);
    s.objects.set(`cloud-v2/runtime/releases/archives/${digest}.tar.gz`, f.bytes);
    await s.store.publish(f.archive, sourceSha, sourceSha256);
    expect(JSON.parse(s.objects.get(runtimeCapabilitiesKey(digest))!.toString())).toEqual({ version: 1, sha256: digest, sourceSha256, commit: sourceSha, features });
    await s.store.publish(f.archive, sourceSha, sourceSha256);
    expect(s.objects.get(`cloud-v2/runtime/${digest}.tar.gz`)).toEqual(f.bytes);
  });

  it.each(["missing", "incomplete"] as const)("refuses publication when read-back capabilities are %s", async fault => {
    const f = await fixture(), s = storage(fault);
    await expect(s.store.publish(f.archive, sourceSha, sourceSha256)).rejects.toThrow(/capabilit/i);
    expect(s.objects.has(`cloud-v2/runtime/releases/manifests/${sha(f.bytes)}.json`)).toBe(false);
  });

  it("refuses an existing record whose features or source differ without overwriting it", async () => {
    const f = await fixture(), digest = sha(f.bytes);
    for (const changed of [{ features: [features[0]] }, { features: [...features, "undeclared-v1"] }, { sourceSha256: "b".repeat(64) }, { commit: "2".repeat(40) }]) {
      const s = storage(), key = runtimeCapabilitiesKey(digest);
      const bytes = Buffer.from(JSON.stringify({ version: 1, sha256: digest, sourceSha256, commit: sourceSha, features, ...changed }));
      s.objects.set(key, bytes);
      await expect(s.store.publish(f.archive, sourceSha, sourceSha256)).rejects.toThrow(/capabilit/i);
      expect(s.objects.get(key)).toEqual(bytes);
    }
  });

  it("refuses a new release without a capability manifest while retaining historical rollback archives", async () => {
    const f = await fixture(false), s = storage(), digest = sha(f.bytes);
    await expect(s.store.publish(f.archive, sourceSha, sourceSha256)).rejects.toThrow(/capabilit/i);
    expect(s.objects.size).toBe(0);
    s.objects.set(`cloud-v2/runtime/${digest}.tar.gz`, f.bytes);
    await s.store.retain({ sha256: digest, release: null });
    expect(s.objects.get(`cloud-v2/runtime/releases/archives/${digest}.tar.gz`)).toEqual(f.bytes);
    await expect(s.store.copy(digest)).rejects.toThrow(/capabilit/i);
  });

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
    expect(JSON.parse(b.objects.get(runtimeCapabilitiesKey(manifest.sha256))!.toString()).features).toEqual(features);
    b.objects.delete(`cloud-v2/runtime/${manifest.sha256}.tar.gz`);
    b.objects.delete(runtimeCapabilitiesKey(manifest.sha256));
    await b.store.retain({ sha256: manifest.sha256, release: null });
    expect(b.objects.get(`cloud-v2/runtime/${manifest.sha256}.tar.gz`)).toEqual(f.bytes);
    expect(JSON.parse(b.objects.get(runtimeCapabilitiesKey(manifest.sha256))!.toString()).features).toEqual(features);
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
