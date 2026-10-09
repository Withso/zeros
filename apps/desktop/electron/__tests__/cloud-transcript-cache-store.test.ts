import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudTranscriptCacheStore } from "../cloud-transcript-cache-store";

const roots: string[] = [];
const owner = { accountId: "account-a", organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "chat-a" };
const message = (id: string, text = id) => ({ msgId: id, kind: "text", createdAt: 100, payload: JSON.stringify({ id, kind: "text", role: "agent", text, createdAt: 100 }) });
const window = (revision = 1, text = "confirmed") => ({ revision, recordEpoch: null, cursor: "m-1", messages: [message("m-1", text)] });
const projection = { organizationId: owner.organizationId, workspaceId: owner.workspaceId, generation: 2,
  engineInstanceId: "33333333-3333-4333-8333-333333333333", bootId: "44444444-4444-4444-8444-444444444444",
  writerEpoch: "55555555-5555-4555-8555-555555555555", fundingOwnerUserId: "66666666-6666-4666-8666-666666666666",
  fundingOwnerEpoch: 1, version: 1 as const, mode: "boot-owner-v1" as const, fundingScope: "workspace-roles-v1" as const,
  mirroredSequence: 20, sealedSequence: 20, complete: true };
const restoreHead = (restoreRevision: number, incomplete = false, deleted = false) => ({ projection,
  conversationId: owner.chatId, head: { conversationId: owner.chatId, originWriterEpoch: projection.writerEpoch,
    source: { kind: "mutation" as const, mutationId: "77777777-7777-4777-8777-777777777777", operation: deleted ? "delete" as const : "repair" as const },
    restoreRevision, deleted, recordSequence: incomplete ? null : 10, eventSequence: 9,
    manifestSha256: incomplete ? null : "a".repeat(64), incompleteReason: incomplete ? "history_limit" as const : null } });
async function fixture(options: { maxEntries?: number; maxBytes?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-transcripts-"));
  roots.push(root);
  const directory = path.join(root, "cache");
  return { directory, store: new CloudTranscriptCacheStore(directory, options) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("durable desktop cloud transcript windows", () => {
  it.each(["incomplete", "deleted"] as const)("keeps an exact %s restore fence through disk reopen and late writes", async kind => {
    const { directory, store } = await fixture();
    const old = store.readReceipt(owner);
    store.write(owner, { ...window(1000), restoreHead: restoreHead(4) }, old.historyEpoch);
    const sibling = { ...owner, chatId: "chat-b" }; store.write(sibling, window(2));
    const fence = restoreHead(5, kind === "incomplete", kind === "deleted");
    store.prune({ ...owner, restoreHead: fence });
    store.write(owner, { ...window(1_000_000, "late old response"), restoreHead: restoreHead(4) }, old.historyEpoch);
    const restored = new CloudTranscriptCacheStore(directory);
    expect(restored.read(owner)).toBeNull();
    expect(restored.readReceipt(owner).restoreHead).toEqual(fence);
    expect(restored.read(sibling)?.revision).toBe(2);
    const receipt = restored.readReceipt(owner);
    restored.write(owner, window(1_000_001, "headless old response"), receipt.historyEpoch);
    expect(restored.read(owner)).toBeNull();
    const repair = restoreHead(6);
    restored.prune({ ...owner, restoreHead: repair });
    restored.write(owner, { ...window(1, "verified repair"), restoreHead: repair }, restored.readReceipt(owner).historyEpoch);
    expect(new CloudTranscriptCacheStore(directory).read(owner)?.messages[0]?.payload).toContain("verified repair");
  });
  it("does not let an evicted pre-fence write recreate a retired conversation", async () => {
    const { store } = await fixture({ maxEntries: 1 });
    const old = store.readReceipt(owner);
    store.prune({ ...owner, restoreHead: restoreHead(5, true) });
    store.write({ ...owner, chatId: "other" }, window(2));
    store.write(owner, { ...window(1000), restoreHead: restoreHead(4) }, old.historyEpoch);
    expect(store.read(owner)).toBeNull();
  });
  it("refuses a foreign restore fence and equal-revision source conflicts without damaging the current window", async () => {
    const { store } = await fixture();
    const current = restoreHead(5);
    store.prune({ ...owner, restoreHead: current });
    store.write(owner, { ...window(), restoreHead: current }, store.readReceipt(owner).historyEpoch);
    expect(() => store.prune({ ...owner, restoreHead: { ...current, projection: { ...projection, workspaceId: owner.organizationId } } })).toThrow();
    expect(() => store.prune({ ...owner, restoreHead: { ...current, head: { ...current.head, source: { ...current.head.source, operation: "edit" } } } })).toThrow();
    expect(store.read(owner)).not.toBeNull();
  });
  it("does not allocate a cache on a passive miss", async () => {
    const { directory, store } = await fixture();
    expect(store.read(owner)).toBeNull();
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("restores exact account/org/workspace/chat identity across a restart and A → B → A", async () => {
    const { directory, store } = await fixture();
    store.write(owner, window());
    const otherChat = { ...owner, chatId: "chat-b" };
    store.write(otherChat, window(2, "second chat"));
    const restored = new CloudTranscriptCacheStore(directory);
    expect(restored.read(owner)?.messages[0]?.payload).toContain("confirmed");
    expect(restored.read(otherChat)?.revision).toBe(2);
    expect(restored.read(owner)?.revision).toBe(1);
    for (const other of [{ ...owner, accountId: "account-b" }, { ...owner, organizationId: owner.workspaceId }, { ...owner, workspaceId: owner.organizationId }, { ...owner, chatId: "chat-c" }]) expect(restored.read(other)).toBeNull();
    expect(await readFile(path.join(directory, "index.json"), "utf8")).not.toContain(owner.accountId);
  });
  it("rejects older projection revisions, including after a restart", async () => {
    const { directory, store } = await fixture();
    store.write(owner, window(10, "newer"));
    const restored = new CloudTranscriptCacheStore(directory);
    restored.write(owner, window(9, "older"));
    expect(restored.read(owner)?.revision).toBe(10);
    expect(restored.read(owner)?.messages[0]?.payload).toContain("newer");
    restored.write(owner, window(11, "latest"));
    expect(restored.read(owner)?.revision).toBe(11);
  });
  it("retains at most the last 200 messages, bounded by UTF8 bytes", async () => {
    const { store } = await fixture();
    store.write(owner, { ...window(), messages: Array.from({ length: 250 }, (_, i) => message(`m-${i}`, "é".repeat(3000))) });
    const cached = store.read(owner)!;
    expect(cached.messages.length).toBeGreaterThan(0);
    expect(cached.messages.length).toBeLessThanOrEqual(200);
    expect(cached.messages.at(-1)?.msgId).toBe("m-249");
    expect(Buffer.byteLength(JSON.stringify(cached))).toBeLessThanOrEqual(512 * 1024);
  });
  it("evicts the least recently used window and bounds durable payload bytes", async () => {
    const { directory, store } = await fixture({ maxEntries: 2, maxBytes: 2048 });
    const b = { ...owner, chatId: "chat-b" }, c = { ...owner, chatId: "chat-c" };
    store.write(owner, window()); store.write(b, window()); store.read(owner); store.write(c, window());
    expect(store.read(b)).toBeNull();
    expect(store.read(owner)).not.toBeNull();
    const restored = new CloudTranscriptCacheStore(directory, { maxEntries: 2, maxBytes: 2048 });
    expect(restored.read(b)).toBeNull();
    restored.write({ ...owner, chatId: "large" }, window(2, "x".repeat(1800)));
    const files = (await readdir(directory)).filter(file => file !== "index.json");
    const sizes = await Promise.all(files.map(file => stat(path.join(directory, file))));
    expect(sizes.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(2048);
  });
  it("purges sign-out, owner removal, workspace deletion and chat tombstones independently", async () => {
    const { directory, store } = await fixture();
    const b = { ...owner, chatId: "chat-b" }, otherOrg = { ...owner, organizationId: owner.workspaceId }, otherAccount = { ...owner, accountId: "account-b" };
    for (const key of [owner, b, otherOrg, otherAccount]) store.write(key, window());
    store.prune({ accountId: owner.accountId, organizationId: owner.organizationId, workspaceId: owner.workspaceId, chatId: owner.chatId });
    expect(store.read(owner)).toBeNull(); expect(store.read(b)).not.toBeNull();
    store.prune({ accountId: owner.accountId, organizationId: owner.organizationId, workspaceId: owner.workspaceId });
    expect(store.read(b)).toBeNull(); expect(store.read(otherOrg)).not.toBeNull();
    store.prune({ accountId: owner.accountId, organizationId: otherOrg.organizationId });
    expect(store.read(otherOrg)).toBeNull(); expect(store.read(otherAccount)).not.toBeNull();
    store.prune({ accountId: otherAccount.accountId });
    expect(new CloudTranscriptCacheStore(directory).read(otherAccount)).toBeNull();
    expect((await readdir(directory)).filter(file => file !== "index.json")).toEqual([]);
  });
  it("stores presentation fields without credentials, attachment bytes, raw tool bodies or absolute paths", async () => {
    const { directory, store } = await fixture();
    const text = message("m-1", "Read /srv/zeros/workspace/a.ts; Authorization: Bearer synthetic-token-value");
    const payload = JSON.parse(text.payload);
    payload.accessToken = "synthetic-secret-field";
    payload.attachments = [{ name: "image.png", mimeType: "image/png", kind: "image", thumbnailUri: "data:image/png;base64,c3ludGhldGljLWJ5dGVz", diskPath: "/srv/zeros/private/image.png", attachmentId: "att-1" }];
    payload.authRecovery = { text: "synthetic-private-recovery" };
    text.payload = JSON.stringify(payload);
    const tool = { ...message("tool-1"), kind: "tool", payload: JSON.stringify({ id: "tool-1", kind: "tool", toolCallId: "call-1", title: "Read /srv/zeros/workspace/a.ts", status: "completed", createdAt: 100, updatedAt: 100, rawInput: { password: "synthetic-tool-secret" }, rawOutput: "synthetic-tool-body" }) };
    store.write(owner, { ...window(), messages: [text, tool] });
    const files = await readdir(directory);
    const persisted = (await Promise.all(files.map(file => readFile(path.join(directory, file), "utf8")))).join("\n");
    for (const forbidden of ["synthetic-secret-field", "synthetic-token-value", "synthetic-private-recovery", "synthetic-tool-secret", "synthetic-tool-body", "c3ludGhldGljLWJ5dGVz", "/srv/zeros"]) expect(persisted).not.toContain(forbidden);
    const cached = JSON.parse(store.read(owner)!.messages[0]!.payload);
    expect(cached.attachments[0].attachmentId).toBe("att-1");
    expect(cached.attachments[0].thumbnailUri).toBeUndefined();
    expect(cached.attachments[0].diskPath).toBeUndefined();
  });
  it("fails closed on corrupt index/window files and refuses symlink reads", async () => {
    const { directory, store } = await fixture();
    store.write(owner, window());
    const record = (await readdir(directory)).find(file => file !== "index.json")!;
    await writeFile(path.join(directory, record), "{");
    expect(new CloudTranscriptCacheStore(directory).read(owner)).toBeNull();
    store.write(owner, window(2));
    await rm(path.join(directory, record));
    const external = path.join(path.dirname(directory), "external.json");
    await writeFile(external, JSON.stringify(window()));
    await symlink(external, path.join(directory, record));
    expect(new CloudTranscriptCacheStore(directory).read(owner)).toBeNull();
    await writeFile(path.join(directory, "index.json"), "{");
    expect(new CloudTranscriptCacheStore(directory).read(owner)).toBeNull();
  });
  it("removes unvisited durable windows absent from the new authorized catalog after restart", async () => {
    const { directory, store } = await fixture();
    const removed = { ...owner, workspaceId: owner.organizationId }, otherAccount = { ...owner, accountId: "account-b" };
    for (const key of [owner, removed, otherAccount]) store.write(key, window());
    const restored = new CloudTranscriptCacheStore(directory);
    restored.retainWorkspaces(owner.accountId, [{ organizationId: owner.organizationId, workspaceId: owner.workspaceId }]);
    expect(restored.read(owner)).not.toBeNull(); expect(restored.read(removed)).toBeNull(); expect(restored.read(otherAccount)).not.toBeNull();
    restored.retainWorkspaces(owner.accountId, []); expect(new CloudTranscriptCacheStore(directory).read(owner)).toBeNull();
  });
  it("includes index metadata in its total durable byte budget", async () => {
    const { directory, store } = await fixture({ maxBytes: 1024, maxEntries: 4 });
    for (let i = 0; i < 4; i++) store.write({ ...owner, chatId: `chat-${i}` }, window(1, "x".repeat(100)));
    const files = await readdir(directory), sizes = await Promise.all(files.map(file => stat(path.join(directory, file))));
    expect(sizes.reduce((sum, file) => sum + file.size, 0)).toBeLessThanOrEqual(1024);
  });
});
