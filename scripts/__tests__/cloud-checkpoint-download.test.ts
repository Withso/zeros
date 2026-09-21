import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageCloudRecoveryBlobs } from "../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs";
const directories: string[] = [];
const recovery = () => ({ endpoint: "https://control.example.test/recovery", token: "test-grant", expiresAtMs: Date.now() + 30_000 });
const directory = () => { const value = mkdtempSync(path.join(tmpdir(), "zeros-recovery-download-")); directories.push(value); return value; };
const descriptor = (text: string) => ({ blobId: randomUUID(), contentSha256: createHash("sha256").update(text).digest("hex"), sizeBytes: Buffer.byteLength(text) });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bounded checkpoint download staging", () => {
  it("overlaps small-file downloads within the request cap and verifies every staged file", async () => {
    const entries = Array.from({ length: 40 }, (_, n) => descriptor(`file-${n}`));
    const values = new Map(entries.map((entry, n) => [entry.blobId, `file-${n}`]));
    let release!: () => void, active = 0, maximum = 0;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      active++; maximum = Math.max(maximum, active); await barrier; active--;
      const text = values.get(url.split("/").at(-1)!)!;
      return new Response(text, { headers: { "content-type": "application/octet-stream", "content-length": String(Buffer.byteLength(text)) } });
    }));
    const root = directory(), pending = stageCloudRecoveryBlobs(recovery(), entries, root);
    try { await vi.waitFor(() => expect(active).toBe(16), { timeout: 300 }); }
    finally { release(); await pending; }
    const staged = await pending;
    expect(maximum).toBe(16); expect(staged.size).toBe(40);
    for (const [id, file] of staged) expect(readFileSync(file, "utf8")).toBe(values.get(id));
  });

  it("rejects conflicting aliases before fetching anything", async () => {
    const entry = descriptor("same"), fetcher = vi.fn(async () => new Response("same", { headers: { "content-type": "application/octet-stream", "content-length": "4" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(stageCloudRecoveryBlobs(recovery(), [entry, { ...entry, contentSha256: "a".repeat(64) }], directory())).rejects.toMatchObject({ code: "checkpoint_restore_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsupported oversized objects before scheduling instead of deadlocking a weighted permit", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(stageCloudRecoveryBlobs(recovery(), [{ ...descriptor("x"), sizeBytes: 64 * 1024 * 1024 + 1 }], directory())).rejects.toMatchObject({ code: "checkpoint_restore_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("downloads valid duplicate and empty blobs once while preserving staged payloads", async () => {
    const entry = descriptor(""); const fetcher = vi.fn(async () => new Response(new Uint8Array(), { headers: { "content-type": "application/octet-stream", "content-length": "0" } }));
    vi.stubGlobal("fetch", fetcher); const root = directory();
    const staged = await stageCloudRecoveryBlobs(recovery(), [entry, entry], root);
    expect(fetcher).toHaveBeenCalledOnce(); expect(readFileSync(staged.get(entry.blobId)!)).toHaveLength(0); expect(readdirSync(root)).toHaveLength(1);
  });

  it("bounds aggregate declared bytes and cancels queued work before fetching it", async () => {
    const controller = new AbortController(), root = directory();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const entries = [descriptor("first"), descriptor("second")].map(entry => ({ ...entry, sizeBytes: 40 * 1024 * 1024 }));
    const pending = stageCloudRecoveryBlobs(recovery(), entries, root, controller.signal); void pending.catch(() => {});
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(); await expect(pending).rejects.toMatchObject({ code: "checkpoint_restore_unavailable" });
    expect(fetcher).toHaveBeenCalledOnce(); expect(readdirSync(root)).toHaveLength(0);
  });

  it("cancels and drains a blocked sibling before rejecting a failed download", async () => {
    const entries = [descriptor("slow"), descriptor("fail")], root = directory();
    let drained = false;
    const cancel = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 15)); drained = true; });
    const slow = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith(entries[0].blobId)
      ? new Response(slow, { headers: { "content-type": "application/octet-stream", "content-length": "4" } })
      : new Response("unavailable", { status: 503 })));
    await expect(stageCloudRecoveryBlobs(recovery(), entries, root)).rejects.toMatchObject({ code: "checkpoint_restore_unavailable" });
    expect(cancel).toHaveBeenCalledOnce(); expect(drained).toBe(true); expect(readdirSync(root)).toHaveLength(0);
  });

  it("preserves the retryable setup code when an active blob body is aborted", async () => {
    const controller = new AbortController(), root = directory();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "application/octet-stream", "content-length": "1" },
    })));
    const pending = stageCloudRecoveryBlobs(recovery(), [descriptor("x")], root, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "checkpoint_restore_unavailable" });
    await vi.waitFor(() => expect(readdirSync(root)).toHaveLength(1));
    controller.abort(); await rejected;
    expect(cancel).toHaveBeenCalledOnce(); expect(readdirSync(root)).toHaveLength(0);
  });

  it("cancels an unread body after an exclusive destination-open failure", async () => {
    const entry = descriptor("x"), root = directory();
    const cancel = vi.fn();
    const { writeFileSync } = await import("node:fs"); writeFileSync(path.join(root, entry.blobId), "existing");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "application/octet-stream", "content-length": "1" },
    })));
    await expect(stageCloudRecoveryBlobs(recovery(), [entry], root)).rejects.toMatchObject({ code: "EEXIST" });
    expect(cancel).toHaveBeenCalledOnce(); expect(readFileSync(path.join(root, entry.blobId), "utf8")).toBe("existing");
  });

  it("does not fetch with an expired restore deadline", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(stageCloudRecoveryBlobs({ ...recovery(), expiresAtMs: Date.now() - 1 }, [descriptor("x")], directory())).rejects.toMatchObject({ code: "checkpoint_restore_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects elapsed wall-clock deadlines even before the abort timer can run", async () => {
    const grant = recovery(), root = directory();
    vi.stubGlobal("fetch", vi.fn(async () => {
      // A synchronous filesystem/CPU interval can pass the deadline while the
      // event loop has not yet dispatched the AbortSignal timer.
      vi.spyOn(Date, "now").mockReturnValue(grant.expiresAtMs + 1);
      return new Response("x", { headers: { "content-type": "application/octet-stream", "content-length": "1" } });
    }));
    await expect(stageCloudRecoveryBlobs(grant, [descriptor("x")], root)).rejects.toMatchObject({ code: "checkpoint_restore_unavailable" });
    expect(readdirSync(root)).toHaveLength(0);
  });
});
