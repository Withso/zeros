import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudCheckpointProgressSchema } from "@zeros/protocol/cloud-checkpoint-progress";
import { CloudWorkspaceDurabilityRuntime, scanCloudWorkspaceChanges } from "../cloud-durability-runtime";
import { CloudCheckpointProgressReporter } from "../cloud-checkpoint-progress";
import { captureCloudNativeCheckpoint, cloudCheckpointCaptureFailure } from "../agents/containment/cloud-checkpoint-artifacts.mjs";

const execute = promisify(execFile);
const temporary: string[] = [];
const reporters: CloudCheckpointProgressReporter[] = [];
const header = "x-zeros-checkpoint-capture-failure";
const canary = "PRIVATE-CAPTURE-BODY-PATH-OUTPUT-CANARY";
type Site = "projection" | "file_upload" | "content_append" | "native_upload" | "manifest_upload" | "commit";
type Request = { site: Site; init: RequestInit; reply(): Response };
afterEach(async () => {
  for (const reporter of reporters.splice(0)) reporter.dispose();
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture(intercept: (request: Request) => Response | Promise<Response> = request => request.reply()) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "zeros-capture-detail-")); temporary.push(root);
  const repository = path.join(root, "repository"), data = path.join(root, "data");
  await fs.mkdir(repository); await fs.mkdir(data);
  const git = (...args: string[]) => execute("git", args, { cwd: repository, env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false", GIT_CONFIG_KEY_1: "gc.auto", GIT_CONFIG_VALUE_1: "0" } });
  await git("init", "-q"); await git("config", "user.name", "Capture Test");
  await git("config", "user.email", "capture@example.test");
  await fs.writeFile(path.join(repository, "file.txt"), "base\n");
  await git("add", "."); await git("commit", "-qm", "base");
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID() };
  const authority = { ...scope, heartbeatEndpoint: "https://control.test/internal/v1/cloud-workspaces/engine/heartbeat",
    heartbeatToken: `zwh_${"h".repeat(43)}` };
  const directive = { id: randomUUID(), reason: "before_stop" as const, deadlineAtMs: Date.now() + 60_000 };
  const requests: Site[] = [], observations: RequestInit[] = [];
  let revision = 0, commits = 0;
  const requestFetch = vi.fn<typeof fetch>(async (_input, init) => {
    observations.push(init!);
    return new Response(null, { status: 202 });
  });
  const current = vi.fn(() => true);
  const reporter = new CloudCheckpointProgressReporter({ authority, directive, current, requestFetch,
    registrationEndpoint: "https://control.test/internal/v1/cloud-workspaces/engine/register" });
  reporters.push(reporter);
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const route = new URL(String(input)).pathname;
    let site: Site, reply: () => Response;
    if (route.endsWith("/content/head")) {
      site = "projection"; reply = () => Response.json({ checkpointId: null, currentRevision: revision,
        durableRevision: null, entries: [], nextAfterPath: null });
    } else if (route.endsWith("/blobs/batch")) {
      site = "file_upload"; reply = () => Response.json({ blobs: JSON.parse(String(init?.body)).entries
        .map((entry: { bytesBase64: string }, index: number) => { const bytes = Buffer.from(entry.bytesBase64, "base64");
          return { index, id: randomUUID(), plaintextSha256: sha(bytes), sizeBytes: bytes.length }; }) });
    } else if (route.endsWith("/blobs")) {
      const bytes = init!.body as Uint8Array;
      site = !requests.includes("content_append") ? "file_upload"
        : Buffer.from(bytes).toString("utf8", 0, 100).includes("zeros-cloud-workspace-checkpoint-manifest")
        ? "manifest_upload" : "native_upload";
      reply = () => Response.json({ id: randomUUID(), plaintextSha256: sha(bytes), sizeBytes: bytes.length });
    } else if (route.endsWith("/content/append")) {
      site = "content_append"; reply = () => Response.json({ revision: ++revision });
    } else if (route.endsWith("/checkpoints/commit")) {
      site = "commit"; reply = () => { commits++; return Response.json({ checkpointId: randomUUID(), contentRevision: revision }); };
    } else throw new Error("unexpected capture route");
    requests.push(site);
    return intercept({ site, init: init!, reply });
  });
  const runtime = new CloudWorkspaceDurabilityRuntime(repository, { fetch: fetchImpl, nativeRoots: { data } });
  async function failure() {
    reporter.stage("durability_capture");
    const error: unknown = await runtime.checkpoint(directive, authority).then(() => { throw new Error("capture unexpectedly passed"); }, error => error);
    reporter.fail(error);
    const init = observations.at(-1)!;
    const detail = new Headers(init.headers).get(header);
    const body = CloudCheckpointProgressSchema.parse(JSON.parse(String(init.body)));
    expect(body).toMatchObject({ stage: "durability_capture", state: "failed" });
    expect(body).not.toHaveProperty("captureFailure");
    expect(JSON.stringify({ detail, body })).not.toContain(canary);
    expect(runtime.readFinalCheckpoint(authority)).toBeNull();
    return { error, detail: detail ? JSON.parse(detail) : null, body };
  }
  return { root, repository, data, git, runtime, authority, directive, reporter, requests, observations, current,
    fetchImpl, requestFetch, failure, getCommits: () => commits };
}

describe.runIf(process.platform === "linux")("real cloud capture failure boundaries", () => {
  it.each([
    ["projection", 401, "invalid_capability", "authority", "authority_rejected"],
    ["file_upload", 503, "object_store_unavailable", "http_refusal", "storage"],
    ["content_append", 409, "idempotency_conflict", "idempotency_conflict", "storage"],
    ["native_upload", 422, "invalid_request", "http_refusal", "storage"],
    ["manifest_upload", 403, "engine_authority_rejected", "authority", "authority_rejected"],
    ["commit", 409, "checkpoint_request_rejected", "request_not_current", "authority_rejected"],
  ] as const)("retains %s HTTP %i refusal without granting completion", async (target, status, code, reason, coarse) => {
    const f = await fixture(request => request.site === target ? Response.json({ error: { code } }, { status }) : request.reply());
    const failure = await f.failure();
    expect(failure.detail).toEqual({ version: 1, site: target, reason, httpClass: status >= 500 ? "5xx" : "4xx" });
    expect(failure.body.reason).toBe(coarse);
    expect(f.getCommits()).toBe(0);
  });

  it.each(["projection", "file_upload", "content_append", "native_upload", "manifest_upload", "commit"] as const)(
    "retains %s transport rejection and the original error", async target => {
      const original = new Error(canary);
      const f = await fixture(request => { if (request.site === target) throw original; return request.reply(); });
      const failure = await f.failure();
      expect(failure.error).toBe(original);
      expect(failure.detail).toEqual({ version: 1, site: target, reason: "transport", httpClass: "none" });
    });

  it.each(["malformed", "oversized", "extra-key", "unknown-code"])("ignores %s refusal bodies without retry or text classification", async kind => {
    const f = await fixture(request => {
      if (request.site !== "content_append") return request.reply();
      const body = kind === "malformed" ? `{${canary}` : kind === "oversized" ? `${" ".repeat(2 * 1024 * 1024 + 1)}{"error":{"code":"revision_conflict"}}`
        : JSON.stringify({ error: kind === "extra-key" ? { code: "revision_conflict", message: canary } : { code: canary } });
      return new Response(body, { status: 409, headers: { "content-type": "application/json" } });
    });
    expect((await f.failure()).detail).toEqual({ version: 1, site: "content_append", reason: "http_refusal", httpClass: "4xx" });
    expect(f.requests.filter(site => site === "content_append")).toHaveLength(1);
  });

  it.each(["malformed", "oversized", "content-type", "shape"])("retains %s success-body refusal at the projection boundary", async kind => {
    const f = await fixture(() => kind === "shape" ? Response.json({ message: canary }) : new Response(`{${canary}`, {
      headers: { "content-type": kind === "content-type" ? "text/plain" : "application/json",
        ...(kind === "oversized" ? { "content-length": "2097153" } : {}) },
    }));
    expect((await f.failure()).detail).toEqual({ version: 1, site: "projection", reason: "response_invalid", httpClass: "2xx" });
    expect(f.requests).toEqual(["projection"]);
  });

  it.each(["file_upload", "native_upload", "manifest_upload"] as const)("reports a wrong digest at %s as integrity, never a checkpoint", async target => {
    const f = await fixture(async request => {
      const response = request.reply(); if (request.site !== target) return response;
      const raw = await response.json();
      if (target === "file_upload") raw.blobs[0].plaintextSha256 = "0".repeat(64);
      else raw.plaintextSha256 = "0".repeat(64);
      return Response.json(raw);
    });
    expect((await f.failure()).detail).toEqual({ version: 1, site: target, reason: "integrity", httpClass: "2xx" });
    expect(f.getCommits()).toBe(0);
  });

  it("distinguishes a lost commit response from an invalid acknowledged response without replay", async () => {
    const original = new Error(canary);
    const f = await fixture(request => { const response = request.reply(); if (request.site === "commit") throw original; return response; });
    const failure = await f.failure();
    expect(failure.error).toBe(original);
    expect(failure.detail).toEqual({ version: 1, site: "commit", reason: "transport", httpClass: "none" });
    expect(f.getCommits()).toBe(1); expect(f.requests.filter(site => site === "commit")).toHaveLength(1);
  });

  it.each(["json", "identity"])("requires a valid commit ACK despite %s failure detail", async kind => {
    const f = await fixture(request => request.site === "commit" ? kind === "json"
      ? new Response(`{${canary}`, { headers: { "content-type": "application/json" } })
      : Response.json({ checkpointId: canary }) : request.reply());
    expect((await f.failure()).detail).toEqual({ version: 1, site: "commit_ack", reason: "response_invalid", httpClass: "2xx" });
  });

  it("distinguishes a real request abort from the original capture deadline", async () => {
    const controller = new AbortController();
    const f = await fixture(() => { controller.abort(); throw controller.signal.reason; });
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    expect((await f.failure()).detail).toEqual({ version: 1, site: "projection", reason: "request_timeout", httpClass: "none" });
  });

  it("keeps the original deadline through an actual revision conflict", async () => {
    const f = await fixture(request => {
      if (request.site !== "content_append") return request.reply();
      vi.spyOn(Date, "now").mockReturnValue(f.directive.deadlineAtMs);
      return Response.json({ error: { code: "revision_conflict" } }, { status: 409 });
    });
    expect((await f.failure()).detail).toEqual({ version: 1, site: "content_append", reason: "deadline", httpClass: "4xx" });
    expect(f.requests.filter(site => site === "projection")).toHaveLength(1);
  });

  it("reports exhausted real revision conflicts at the append boundary", async () => {
    const f = await fixture(request => request.site === "content_append"
      ? Response.json({ error: { code: "revision_conflict" } }, { status: 409 }) : request.reply());
    expect((await f.failure()).detail).toEqual({ version: 1, site: "content_append", reason: "revision_conflict", httpClass: "4xx" });
    expect(f.requests.filter(site => site === "content_append")).toHaveLength(3);
  });

  it.each(["content", "inventory"])("observes a real native %s mutation after upload", async kind => {
    let changed = false;
    const f = await fixture(async request => {
      const response = request.reply();
      if (request.site === "native_upload" && !changed) { changed = true;
        await fs.writeFile(kind === "content" ? nativeFile : path.join(directory, "new.json"), "after!\n"); }
      return response;
    });
    const directory = path.join(f.data, "design-storage", sha(Buffer.from(f.repository)).slice(0, 32));
    await fs.mkdir(directory, { recursive: true });
    const nativeFile = path.join(directory, "canvas.json"); await fs.writeFile(nativeFile, "before\n");
    expect((await f.failure()).detail).toEqual({ version: 1, site: "native_verify", reason: "native_changed", httpClass: "none" });
    expect(f.getCommits()).toBe(0);
  });

  it("observes an unsafe native link before any native upload", async () => {
    const f = await fixture();
    const directory = path.join(f.data, "design-storage", sha(Buffer.from(f.repository)).slice(0, 32));
    await fs.mkdir(directory, { recursive: true }); await fs.symlink(path.join(f.repository, "file.txt"), path.join(directory, "canvas.json"));
    expect((await f.failure()).detail).toEqual({ version: 1, site: "native_inventory", reason: "native_invalid", httpClass: "none" });
    expect(f.requests).not.toContain("native_upload");
  });

  it("reports a real unreadable working file under an unprivileged identity", async () => {
    const f = await fixture(); const file = path.join(f.repository, "file.txt"); await fs.chmod(file, 0);
    try { expect((await f.failure()).detail).toEqual({ version: 1, site: "file_scan", reason: "filesystem", httpClass: "none" }); }
    finally { await fs.chmod(file, 0o600); }
    expect(f.requests).toEqual(["projection"]);
  });

  it("reports a real Git scan failure without serializing Git output", async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.repository, ".git", "HEAD"), canary);
    expect((await f.failure()).detail).toEqual({ version: 1, site: "file_scan", reason: "git_failed", httpClass: "none" });
    expect(f.requests).toEqual(["projection"]);
  });

  it("joins both admitted file uploads, stops new admission and keeps the first observed failure", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), second = new Promise<void>(resolve => { entered = resolve; });
    const firstFailure = new Error("first observed transport failure"), lateFailure = new Error("later transport failure");
    let uploads = 0;
    const f = await fixture(async request => {
      if (request.site !== "file_upload") return request.reply();
      uploads++;
      if (uploads === 1) { await gate; throw lateFailure; }
      entered(); throw firstFailure;
    });
    for (const name of ["a.bin", "b.bin", "c.bin"]) await fs.writeFile(path.join(f.repository, name), Buffer.alloc(4 * 1024 * 1024 + 1, 65));
    let settled = false;
    const capture = f.failure().finally(() => { settled = true; });
    try {
      await second;
      await new Promise(resolve => setImmediate(resolve));
      expect(uploads).toBe(2); expect(settled).toBe(false);
      await expect(f.runtime.checkpoint(f.directive, f.authority)).rejects.toThrow("already in progress");
      expect(f.requests).not.toContain("content_append");
    } finally { release(); }
    const failed = await capture;
    expect(failed.error).toBe(firstFailure);
    expect(failed.detail).toEqual({ version: 1, site: "file_upload", reason: "transport", httpClass: "none" });
    expect(uploads).toBe(2);
  });

  it("keeps the first capture failure through cancellation, a late report and cleanup", async () => {
    const original = new Error(canary);
    const f = await fixture(() => { throw original; });
    let reply!: (value: Response) => void;
    f.requestFetch.mockImplementationOnce(async (_url, init) => {
      f.observations.push(init!); return new Promise(resolve => { reply = resolve; });
    });
    const failed = await f.failure(), before = f.observations.map(init => ({ body: init.body, header: new Headers(init.headers).get(header) }));
    expect(f.requestFetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    f.current.mockReturnValue(false);
    f.reporter.fail(new Error("cleanup canary")); f.reporter.complete();
    reply(new Response(canary, { status: 404 }));
    await new Promise(resolve => setImmediate(resolve));
    f.current.mockReturnValue(true); f.reporter.stage("final_completion");
    expect(f.observations.map(init => ({ body: init.body, header: new Headers(init.headers).get(header) }))).toEqual(before);
    expect(failed.detail).toEqual({ version: 1, site: "projection", reason: "transport", httpClass: "none" });
  });

  it("does not mistake arbitrary error metadata for a known capture cause", async () => {
    const original = Object.assign(new Error(canary), { name: "CloudCheckpointDeadlineError", code: "engine_authority_rejected",
      captureFailure: { version: 1, site: "commit_ack", reason: "authority", httpClass: "4xx" } });
    const f = await fixture(() => { throw original; });
    const failed = await f.failure();
    expect(failed.error).toBe(original);
    expect(failed.detail).toEqual({ version: 1, site: "projection", reason: "transport", httpClass: "none" });
    expect(failed.body.reason).toBe("storage");
  });

  it.each(["working-tree", "design"])("distinguishes the final %s proof after native capture", async kind => {
    let changed = false;
    const f = await fixture(async request => {
      const response = request.reply();
      if (request.site === "native_upload" && !changed) {
        changed = true;
        if (kind === "working-tree") await fs.writeFile(path.join(f.repository, "file.txt"), "changed\n");
        else await fs.writeFile(path.join(f.repository, ".zeros", "settings.local.toml"), '[design]\ndirectory = "Changed"\n');
      }
      return response;
    });
    // Establish the native .zeros directory before its inventory; only the
    // excluded private selection changes, leaving the native inventory stable.
    await fs.mkdir(path.join(f.repository, ".zeros"));
    await fs.writeFile(path.join(f.repository, ".zeros", "settings.local.toml"), '[design]\ndirectory = "Initial"\n');
    expect((await f.failure()).detail).toEqual({ version: 1, site: "final_verify",
      reason: kind === "working-tree" ? "working_tree_changed" : "design_changed", httpClass: "none" });
    expect(f.requests).not.toContain("manifest_upload");
  });

  it("keeps native buffer ownership until a delayed upload settles after the original deadline", async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void, bytes: Uint8Array | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; }), uploading = new Promise<void>(resolve => { entered = resolve; });
    let done = false;
    const capture = captureCloudNativeCheckpoint({ roots: { repository: f.repository }, deadlineAtMs: f.directive.deadlineAtMs,
      putChunk: async value => {
        bytes = value; entered(); await gate;
        return { blobId: randomUUID(), contentSha256: sha(value), sizeBytes: value.length };
      } }).then(() => { throw new Error("late capture passed"); }, error => error).finally(() => { done = true; });
    try {
      await uploading; vi.spyOn(Date, "now").mockReturnValue(f.directive.deadlineAtMs);
      await new Promise(resolve => setImmediate(resolve));
      expect(done).toBe(false); expect(bytes!.some(byte => byte !== 0)).toBe(true);
    } finally { release(); }
    const error = await capture;
    expect(cloudCheckpointCaptureFailure(error)).toEqual({ version: 1, site: "native_pack", reason: "deadline", httpClass: "none" });
    expect(bytes!.every(byte => byte === 0)).toBe(true);
  });

  it("reports a real native pack Git failure after a valid inventory", async () => {
    const f = await fixture(); let removed = false;
    const error = await captureCloudNativeCheckpoint({ roots: { repository: f.repository }, deadlineAtMs: f.directive.deadlineAtMs,
      putChunk: async value => {
        if (!removed) { removed = true; await fs.rm(path.join(f.repository, ".git", "objects"), { recursive: true });
          await fs.mkdir(path.join(f.repository, ".git", "objects")); }
        return { blobId: randomUUID(), contentSha256: sha(value), sizeBytes: value.length };
      } }).then(() => { throw new Error("broken Git capture passed"); }, error => error);
    expect(cloudCheckpointCaptureFailure(error)).toEqual({ version: 1, site: "native_pack", reason: "git_failed", httpClass: "none" });
  });

  it("Local scanners publish no capture metadata or network observations", async () => {
    const f = await fixture(); await fs.symlink("../private-canary", path.join(f.repository, "unsafe-link"));
    const error = await scanCloudWorkspaceChanges(f.repository).then(() => { throw new Error("unsafe scan passed"); }, error => error);
    expect(error).toBeInstanceOf(Error);
    expect(cloudCheckpointCaptureFailure(error)).toBeUndefined();
    expect(f.requests).toEqual([]); expect(f.observations).toEqual([]);
  });

  it("retains the existing strict append conflict body acceptance bound", async () => {
    let conflicts = 0;
    const f = await fixture(request => request.site === "content_append" && ++conflicts <= 1
      ? new Response(`${" ".repeat(1024)}{"error":{"code":"revision_conflict"}}`, { status: 409, headers: { "content-type": "application/json" } })
      : request.reply());
    await f.runtime.checkpoint(f.directive, f.authority);
    expect(f.requests.filter(site => site === "content_append")).toHaveLength(2);
    expect(f.getCommits()).toBe(1); expect(f.runtime.readFinalCheckpoint(f.authority)).not.toBeNull();
    expect(f.observations).toEqual([]);
  });
});
