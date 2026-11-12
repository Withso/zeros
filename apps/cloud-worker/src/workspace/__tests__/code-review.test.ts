import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeReviewListResult, CodeReviewThread } from "@zeros/protocol/code-review";
import { CLOUD_REVIEW_LIMITS, WorkerCodeReview } from "../code-review";
import { WorkspaceScope } from "../scope";
import { config } from "../../__tests__/worker-fixtures";

const require = createRequire(import.meta.url);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const user = { userId: "44444444-4444-4444-8444-444444444444", userName: "Fixture reviewer" };
const anchor = { path: "example.ts", side: "new", startLine: 1, endLine: 1, revision: "original" };
async function fixture(limits = CLOUD_REVIEW_LIMITS, configure = true) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-review-store-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo"), state = join(directory, "state");
  await mkdir(root); await mkdir(state); await writeFile(join(root, "example.ts"), "source\n");
  const scope = new WorkspaceScope({ ...config.workspace, checkoutPath: root }), changed = vi.fn();
  const store = new WorkerCodeReview(scope, state, changed, limits);
  cleanups.push(() => store.close());
  if (configure) await store.configure(user);
  const create = (body = "comment", requestId?: string) => store.handle("codeReview.create", { workspaceId: scope.key, anchor, body, requestId }) as CodeReviewThread;
  const list = () => store.handle("codeReview.list", { workspaceId: scope.key }) as CodeReviewListResult;
  return { directory, root, state, scope, store, changed, create, list };
}

describe("bounded private VM review storage", () => {
  it("requires explicit workspace ownership and never accepts a selected actor", async () => {
    const f = await fixture();
    expect(() => f.store.handle("codeReview.list", {})).toThrow();
    expect(() => f.store.handle("codeReview.list", { workspaceId: "foreign" })).toThrow();
    expect(() => f.store.handle("codeReview.create", { workspaceId: f.scope.key, anchor, body: "comment", author: user })).toThrow();
    expect(f.list().threads).toEqual([]);
    await expect(f.store.configure({ ...user, userId: "55555555-5555-4555-8555-555555555555" })).rejects.toMatchObject({ code: "CODE_REVIEW_AUTHORITY_REJECTED" });
  });

  it.each(["threads", "comments", "requests"] as const)("bounds %s without losing retry receipts or existing comments", async limit => {
    const f = await fixture({ ...CLOUD_REVIEW_LIMITS, [limit]: 1 });
    const first = f.create("first", "create-once");
    expect(() => f.create("second", "second-create")).toThrow(expect.objectContaining({ code: "CODE_REVIEW_CAPACITY" }));
    expect(f.create("first", "create-once")).toEqual(first);
    expect(f.list().threads).toEqual([first]);
  });

  it("checks UTF-8 bytes independently of the Local character limit", async () => {
    const f = await fixture({ ...CLOUD_REVIEW_LIMITS, bodyBytes: 8 });
    const first = f.create("🙂🙂");
    expect(() => f.create("🙂🙂x")).toThrow(expect.objectContaining({ code: "CODE_REVIEW_CAPACITY" }));
    expect(f.list().threads).toEqual([first]);
  });

  it("enforces the byte budget on an existing database with a different SQLite page size", async () => {
    const f = await fixture({ ...CLOUD_REVIEW_LIMITS, bytes: 64 * 1024 }, false);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(join(f.state, "review.sqlite"));
    db.exec("PRAGMA page_size=65536; VACUUM;"); db.close();
    await expect(f.store.configure(user)).rejects.toMatchObject({ code: "CODE_REVIEW_CAPACITY" });
    expect(f.store.enabled).toBe(false);
  });

  it("rolls back a full SQLite transaction and leaves the prior snapshot readable", async () => {
    const f = await fixture({ ...CLOUD_REVIEW_LIMITS, bytes: 128 * 1024 });
    let accepted = 0;
    for (let i = 0; i < 32; i++) {
      try { f.create("x".repeat(20_000), `create-${i}`); accepted++; }
      catch (error) { expect(error).toMatchObject({ code: "CODE_REVIEW_CAPACITY" }); break; }
    }
    expect(accepted).toBeGreaterThan(0); expect(accepted).toBeLessThan(32);
    expect(f.list().threads).toHaveLength(accepted);
    expect((await stat(join(f.state, "review.sqlite"))).size).toBeLessThanOrEqual(128 * 1024);
    expect(f.changed).toHaveBeenCalledTimes(accepted);
  });

  it("refuses a foreign restored owner and symlinked storage without modifying the target", async () => {
    const f = await fixture(); f.create(); f.store.close();
    const foreign = new WorkerCodeReview(new WorkspaceScope({ ...f.scope.workspace, id: "55555555-5555-4555-8555-555555555555" }), f.state, () => {});
    cleanups.push(() => foreign.close());
    await expect(foreign.configure(user)).rejects.toMatchObject({ code: "CODE_REVIEW_AUTHORITY_REJECTED" });
    const other = await fixture(CLOUD_REVIEW_LIMITS, false), file = join(other.directory, "untouched");
    await writeFile(file, "do not change"); await symlink(file, join(other.state, "review.sqlite"));
    await expect(other.store.configure(user)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("do not change");
  });

  it.each([".git/config", ".zeros/review", ".env", "alias.ts"])("shares Local's private and physical-path policy (%s)", async file => {
    const f = await fixture();
    await symlink(join(f.root, "example.ts"), join(f.root, "alias.ts"));
    expect(() => f.store.handle("codeReview.create", { workspaceId: f.scope.key, anchor: { ...anchor, path: file }, body: "comment" }))
      .toThrow(expect.objectContaining({ code: file === ".git/config" ? "CODE_REVIEW_INVALID" : "CODE_REVIEW_PATH_DENIED" }));
    expect(f.list().threads).toEqual([]);
  });
});

describe("activated workspaces: each review mutation is its requester's", () => {
  it("opens without a workspace-wide reviewer, refuses a mutation with no requester, and authors each one as its requester", async () => {
    const { operationEnvironment } = await import("../../sharing/operation-environment");
    const f = await fixture(CLOUD_REVIEW_LIMITS, false);
    await f.store.configurePerRequester();
    expect(f.store.enabled).toBe(true);
    expect(() => f.create("no requester")).toThrow();
    const alex = "44444444-4444-4444-8444-444444444444", sam = "55555555-5555-4555-8555-555555555555";
    const as = <T>(userId: string, userName: string, work: () => T) => operationEnvironment.run({ git: {}, zeros: {}, requester: { userId, userName } }, work);
    const thread = as(alex, "Alex Rivera", () => f.create("from alex"));
    expect(JSON.stringify(thread)).toContain(`human:${alex}`);
    const reply = as(sam, "Sam Lee", () => f.store.handle("codeReview.reply", { workspaceId: f.scope.key, threadId: thread.id, body: "from sam" }));
    expect(JSON.stringify(reply)).toContain(`human:${sam}`);
    expect(JSON.stringify(reply)).not.toContain(`"name":"Fixture reviewer"`);
    expect(f.list().threads).toHaveLength(1);
  });
});
