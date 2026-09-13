import { describe, expect, it, vi } from "vitest";
import { RunPreviewCache, findRunPreviewUrl } from "../run-preview-cache";

const target = {
  folderKey: "/repo/a",
  workspaceId: "workspace-a",
  sessionId: "run-test",
  startedAt: 1,
};

describe("run preview addresses", () => {
  it("keeps addresses near the start of a large PTY chunk", () => {
    const cache = new RunPreviewCache();
    cache.append(
      target,
      "http://localhost:5173/\n" + "build progress\n".repeat(1000),
    );
    expect(cache.peek(target)).toBe("http://localhost:5173/");
  });
  it("finds the local server address without mistaking documentation or LAN links for it", () => {
    expect(
      findRunPreviewUrl(
        "Docs: https://vite.dev/\nLocal: \x1b[36mhttp://localhost:5173/app\x1b[0m\nNetwork: http://192.168.1.2:5173/\n",
      ),
    ).toBe("http://localhost:5173/app");
    expect(findRunPreviewUrl("Listening (http://0.0.0.0:3000/).\n")).toBe(
      "http://localhost:3000/",
    );
    expect(findRunPreviewUrl("http://[::]:3000/\n")).toBe(
      "http://localhost:3000/",
    );
    expect(findRunPreviewUrl("http://[::1]:3000/\n")).toBe(
      "http://[::1]:3000/",
    );
    expect(
      findRunPreviewUrl(
        "http://user:password@localhost:3000/\nhttps://example.com/\n",
      ),
    ).toBeNull();
  });

  it("holds split URLs until the output line is complete and publishes only address changes", () => {
    const cache = new RunPreviewCache();
    const changed = vi.fn();
    cache.subscribe(changed);
    cache.append(target, "Local: \x1b[36mhttp://local");
    cache.append(target, "host:51");
    expect(cache.peek(target)).toBeNull();
    cache.append(target, "73/\x1b[0m\n");
    expect(cache.peek(target)).toBe("http://localhost:5173/");
    cache.append(target, "more output\nhttp://localhost:5173/\n");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("shares snapshot requests and lets newer streamed addresses win", async () => {
    const cache = new RunPreviewCache();
    let resolve!: (value: { log: string }) => void;
    const fetch = vi.fn(
      () =>
        new Promise<{ log: string }>((done) => {
          resolve = done;
        }),
    );
    const first = cache.warm(target, fetch);
    const second = cache.warm(target, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    cache.append(target, "http://localhost:4000/\n");
    resolve({ log: "http://localhost:3000/\n" });
    await Promise.all([first, second]);
    expect(cache.peek(target)).toBe("http://localhost:4000/");
  });

  it("restores exact-run snapshots and never carries addresses into another run or workspace", async () => {
    const cache = new RunPreviewCache();
    await cache.warm(target, async () => ({ log: "http://localhost:3000/\n" }));
    const next = { ...target, startedAt: 2 };
    const other = {
      ...target,
      folderKey: "/repo/b",
      workspaceId: "workspace-b",
    };
    expect(cache.peek(next)).toBeNull();
    expect(cache.peek(other)).toBeNull();
    expect(cache.peek(target)).toBe("http://localhost:3000/");
    await cache.warm(target, async () => {
      throw new Error("offline");
    });
    expect(cache.peek(target)).toBe("http://localhost:3000/");
  });

  it("refreshes a cached address after output was missed while hidden", async () => {
    const cache = new RunPreviewCache();
    cache.append(target, "http://localhost:3000/\n");
    await cache.warm(target, async () => ({
      log: "http://localhost:3000/\nhttp://localhost:4000/\n",
    }));
    expect(cache.peek(target)).toBe("http://localhost:4000/");
  });

  it("accepts a recovered address when only ordinary output arrives during its read", async () => {
    const cache = new RunPreviewCache();
    cache.append(target, "http://localhost:3000/\n");
    let resolve!: (value: { log: string }) => void;
    const pending = cache.warm(
      target,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    cache.append(target, "build progress\n");
    resolve({ log: "http://localhost:4000/\n" });
    await pending;
    expect(cache.peek(target)).toBe("http://localhost:4000/");
  });

  it("bounds retained runs and rejects snapshots for removed owners", async () => {
    const cache = new RunPreviewCache(2);
    cache.append(target, "http://localhost:3000/\n");
    cache.append({ ...target, startedAt: 2 }, "http://localhost:3001/\n");
    cache.append({ ...target, startedAt: 3 }, "http://localhost:3002/\n");
    expect(cache.peek(target)).toBeNull();
    let resolve!: (value: { log: string }) => void;
    const pending = cache.warm(
      target,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    cache.clearFolders((folder) => folder === target.folderKey);
    resolve({ log: "http://localhost:9999/\n" });
    await pending;
    expect(cache.peek(target)).toBeNull();
  });

  it("queues one fresh read when a workspace returns before its old snapshot settles", async () => {
    const cache = new RunPreviewCache();
    let resolve!: (value: { log: string }) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({ log: "http://localhost:4000/\n" });
    const old = cache.warm(target, fetch);
    cache.invalidate(target);
    const resumed = cache.warm(target, fetch);
    const shared = cache.warm(target, fetch);
    resolve({ log: "http://localhost:3000/\n" });
    await Promise.all([old, resumed, shared]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cache.peek(target)).toBe("http://localhost:4000/");
  });

  it("cancels queued recovery reads if the workspace hides again", async () => {
    const cache = new RunPreviewCache();
    let resolve!: (value: { log: string }) => void;
    const fetch = vi.fn(
      () =>
        new Promise<{ log: string }>((done) => {
          resolve = done;
        }),
    );
    const old = cache.warm(target, fetch);
    cache.invalidate(target);
    const resumed = cache.warm(target, fetch);
    cache.invalidate(target);
    resolve({ log: "http://localhost:3000/\n" });
    await Promise.all([old, resumed]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.peek(target)).toBeNull();
  });
});
