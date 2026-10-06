import { describe, expect, it, vi } from "vitest";
import { GithubReadCredentials } from "./github-read-credentials.js";

const repo = { installationId: 12, repositoryId: 34 };
function fixture(maxEntries = 64) {
  let now = 1_000_000, next = 0;
  const broker = { mintWorkspaceRead: vi.fn(async () => ({ token: `synthetic-read-${++next}`, expiresAtMs: now + 3_600_000 })), revoke: vi.fn(async () => {}) };
  const cache = new GithubReadCredentials(broker, { now: () => now, maxEntries });
  return { cache, broker, advance: (ms: number) => { now += ms; } };
}
describe("backend-only GitHub read credential cache", () => {
  it("shares minting and reuses a credential until five minutes before expiry", async () => {
    const f = fixture(), read = vi.fn(async (token: string) => token);
    const values = await Promise.all([f.cache.use(repo, read), f.cache.use(repo, read)]);
    expect(values[0] === values[1]).toBe(true);
    expect(f.broker.mintWorkspaceRead).toHaveBeenCalledTimes(1);
    expect(f.broker.revoke).not.toHaveBeenCalled();
    f.advance(55 * 60_000);
    expect(await f.cache.use(repo, read) === values[0]).toBe(false);
    expect(f.broker.mintWorkspaceRead).toHaveBeenCalledTimes(2);
    expect(f.broker.revoke).toHaveBeenCalledTimes(1);
    await f.cache.close();
    expect(f.broker.revoke).toHaveBeenCalledTimes(2);
  });
  it("never shares between repositories or installations and revokes an evicted entry", async () => {
    const f = fixture(1), read = async (token: string) => token;
    const first = await f.cache.use(repo, read);
    const second = await f.cache.use({ ...repo, repositoryId: 35 }, read);
    const third = await f.cache.use({ ...repo, installationId: 13 }, read);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(f.broker.mintWorkspaceRead).toHaveBeenCalledTimes(3);
    expect(f.broker.revoke).toHaveBeenCalledTimes(2);
    await f.cache.close();
    expect(f.broker.revoke).toHaveBeenCalledTimes(3);
  });
  it("sweeps expired credentials even without another read", async () => {
    const f = fixture();
    await f.cache.use(repo, async () => undefined);
    f.advance(60 * 60_000);
    await f.cache.cleanup();
    expect(f.broker.revoke).toHaveBeenCalledTimes(1);
    await f.cache.close();
    expect(f.broker.revoke).toHaveBeenCalledTimes(1);
  });
  it("drains an in-flight read before revoking on shutdown and rejects new reads", async () => {
    const f = fixture();
    let release!: () => void;
    const read = f.cache.use(repo, () => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const closing = f.cache.close();
    expect(f.broker.revoke).not.toHaveBeenCalled();
    await expect(f.cache.use(repo, async () => undefined)).rejects.toThrow("unavailable");
    release(); await read; await closing;
    expect(f.broker.revoke).toHaveBeenCalledTimes(1);
  });
  it("revokes a mint that completes during shutdown", async () => {
    const f = fixture();
    let minted!: (value: { token: string; expiresAtMs: number }) => void;
    f.broker.mintWorkspaceRead.mockImplementationOnce(() => new Promise(resolve => { minted = resolve; }));
    const read = f.cache.use(repo, async () => undefined);
    const rejected = expect(read).rejects.toThrow("unavailable");
    const closing = f.cache.close();
    minted({ token: "synthetic-late-mint", expiresAtMs: 4_600_000 });
    await rejected; await closing;
    expect(f.broker.revoke).toHaveBeenCalledTimes(1);
  });
});
