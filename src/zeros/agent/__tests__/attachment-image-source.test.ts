import { describe, expect, it, vi } from "vitest";

import { AttachmentImageSourceCache } from "../attachment-image-source";

describe("AttachmentImageSourceCache", () => {
  it("deduplicates the exact cwd/path read while isolating other workspaces", async () => {
    const load = vi.fn(async (cwd: string, path: string) => `${cwd}:${path}`);
    const revoke = vi.fn();
    const cache = new AttachmentImageSourceCache(load, revoke);

    const path = ".context-graph/local/attachments/c/a.png";
    const a = cache.acquire("/repo-a", path);
    const same = cache.acquire("/repo-a", path);
    const other = cache.acquire("/repo-b", path);

    expect(await a.source).toBe(`/repo-a:${path}`);
    expect(await same.source).toBe(`/repo-a:${path}`);
    expect(await other.source).toBe(`/repo-b:${path}`);
    expect(load).toHaveBeenCalledTimes(2);

    a.release();
    expect(revoke).not.toHaveBeenCalled();
    same.release();
    expect(revoke).toHaveBeenCalledWith(`/repo-a:${path}`);
    other.release();
  });

  it("releases a source that resolves after its last consumer unmounts", async () => {
    let resolve!: (value: string) => void;
    const load = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const revoke = vi.fn();
    const cache = new AttachmentImageSourceCache(load, revoke);
    const lease = cache.acquire(
      "/repo",
      ".context-graph/local/attachments/chat/a.png",
    );
    lease.release();
    resolve("blob:late");
    expect(await lease.source).toBe("blob:late");
    await Promise.resolve();
    expect(revoke).toHaveBeenCalledWith("blob:late");
  });
});
