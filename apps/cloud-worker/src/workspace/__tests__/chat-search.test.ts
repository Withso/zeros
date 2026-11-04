import { expect, it } from "vitest";
import { ChatService } from "../chat-service";
import { SessionStore } from "../../sessions/session-store";
import { repositoryFixture } from "./repository-fixture";

const text = (msgId: string, content: string) => ({ msgId, kind: "text", createdAt: 100, payload: JSON.stringify({ text: content }) });
async function setup() {
  const fixture = await repositoryFixture(), store = await SessionStore.open(fixture.state, fixture.scope.key);
  for (const id of ["first", "second"]) await store.upsert({ id, folder: fixture.root, createdAt: 1 });
  await store.importMessages("first", [text("phrase", "The relay-core reducer forwards opaque ciphertext. Café."), text("apart", "relay without a core"),
    text("operator", "literal OR expression"), { msgId: "bad", kind: "text", payload: "{bad json", createdAt: 100 },
    { msgId: "empty", kind: "tool", payload: JSON.stringify({ text: "", title: "ignored title" }), createdAt: 100 }]);
  await store.importMessages("second", [{ msgId: "tool", kind: "tool", payload: JSON.stringify({ title: "Read relay/server.ts" }), createdAt: 100 }]);
  const service = new ChatService(store, fixture.scope, async () => {});
  const search = (query: string, extra = {}) => service.handle("messages.search", { query, ...extra }) as Promise<{ hits: Array<{ chatId: string; msgId: string; payload: string; createdAt: number }> }>;
  return { ...fixture, store, service, search };
}

it.each([
  ["ciphertext", ["phrase"]], ["relay", ["apart", "phrase", "tool"]], ["relay-core", ["phrase"]],
  ["core relay", ["apart", "phrase"]], ["cafe", ["phrase"]], ["OR", ["operator"]],
  ["relay OR core", []], ["crypt", []], ["ignored", []], ["\"ciphertext\"", ["phrase"]], ["%_", []], ["   ", []],
])("uses Local literal FTS semantics for %j", async (query, ids) => {
  const { search } = await setup();
  expect((await search(query as string)).hits.map(hit => hit.msgId).sort()).toEqual(ids);
});

it("scopes chats, follows updates/deletions, and rebuilds search after reopening the store", async () => {
  const { search, store, state, scope, root } = await setup();
  expect((await search("relay", { chatId: "second", folder: root })).hits).toEqual([
    { chatId: "second", msgId: "tool", payload: JSON.stringify({ title: "Read relay/server.ts" }), createdAt: 100 },
  ]);
  expect(await search("relay", { chatId: "foreign" })).toEqual({ hits: [] });
  await expect(search("relay", { folder: "/other/workspace" })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  await expect(search("relay", { workspaceId: "foreign" })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  await store.importMessages("first", [text("phrase", "new content")]); await store.delete("second");
  expect((await search("relay")).hits.map(hit => hit.msgId)).toEqual(["apart"]);
  const reopened = await SessionStore.open(state, scope.key), service = new ChatService(reopened, scope, async () => {});
  expect(await service.handle("messages.search", { query: "content", folder: root })).toMatchObject({ hits: [{ chatId: "first", msgId: "phrase" }] });
  expect(await service.handle("messages.search", { query: "server" })).toEqual({ hits: [] });
});

it("bounds hits and invalid search input without treating query syntax as authority", async () => {
  const { store, service, search } = await setup();
  await store.importMessages("first", Array.from({ length: 600 }, (_, i) => text(`many-${i}`, "bounded search")));
  expect((await search("bounded")).hits).toHaveLength(50);
  expect((await search("bounded", { limit: 1000 })).hits).toHaveLength(500);
  expect(await search("bounded", { limit: 0 })).toEqual({ hits: [] });
  for (const query of [null, 12, "q".repeat(4097), "hello\0world"])
    await expect(service.handle("messages.search", { query })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});
