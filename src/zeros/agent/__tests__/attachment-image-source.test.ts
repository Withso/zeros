import { describe, expect, it, vi } from "vitest";

import { AttachmentImageSourceCache } from "../attachment-image-source";

describe("AttachmentImageSourceCache", () => {
  it("deduplicates the exact cwd/path read while isolating other workspaces", async () => {
    const load = vi.fn(async (cwd: string, path: string) => `${cwd}:${path}`);
    const revoke = vi.fn();
    const cache = new AttachmentImageSourceCache(load, revoke);

    const a = cache.acquire("/repo-a", ".context/attachments/c/a.png");
    const same = cache.acquire("/repo-a", ".context/attachments/c/a.png");
    const other = cache.acquire("/repo-b", ".context/attachments/c/a.png");

    expect(await a.source).toBe("/repo-a:.context/attachments/c/a.png");
    expect(await same.source).toBe("/repo-a:.context/attachments/c/a.png");
    expect(await other.source).toBe("/repo-b:.context/attachments/c/a.png");
    expect(load).toHaveBeenCalledTimes(2);

    a.release();
    expect(revoke).not.toHaveBeenCalled();
    same.release();
    expect(revoke).toHaveBeenCalledWith("/repo-a:.context/attachments/c/a.png");
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
    const lease = cache.acquire("/repo", ".context/attachments/chat/a.png");
    lease.release();
    resolve("blob:late");
    expect(await lease.source).toBe("blob:late");
    await Promise.resolve();
    expect(revoke).toHaveBeenCalledWith("blob:late");
  });
});
