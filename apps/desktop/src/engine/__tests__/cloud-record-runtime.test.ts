import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudWorkspaceRecordRuntime } from "../cloud-record-runtime";
import { CodeReviewAgentTools } from "../agents/code-review-tools";
import {
  CloudRuntimeRegistration,
  type CloudRuntimeConfig,
} from "../cloud-runtime-registration";
import { closeZerosDb, openZerosDb, setZerosDbPathForTesting } from "../db";
import { codeReviewStore } from "../db/code-review";
import { deleteChat, listChats, upsertChat, wasChatDeleted } from "../db/chats";
import { deleteTurnsForChat, deleteTurnsFrom } from "../db/turns";
import { clearChatMessages, windowChatMessages, listChatMessagesSince, upsertChatMessage } from "../db/messages";
import { getTurn, startTurn } from "../db/turns";
import { getWorkspaceById, insertWorkspace, updateWorkspace } from "../git/state";
import { testCloudRuntime } from "../agents/__tests__/helpers/test-cloud-runtime";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const authority = {
  heartbeatEndpoint:
    "https://control.example.test/internal/v1/cloud-workspaces/engine/heartbeat",
  heartbeatToken: `zwh_${"h".repeat(43)}`,
  workspaceId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  generation: 1,
  engineInstanceId: "33333333-3333-4333-8333-333333333333",
};

type RemoteEntry = {
  entityKind: string;
  entityId: string;
  revision: number;
  schemaVersion: number;
  document: unknown;
  tombstonedAt: string | null;
};

function turnEntityId(chatId: string, turnId: string): string {
  return `t:${createHash("sha256")
    .update(`${chatId}\0${turnId}`, "utf8")
    .digest("hex")}`;
}

function messageEntityId(chatId: string, messageId: string): string {
  return `m:${createHash("sha256")
    .update(`${chatId}\0${messageId}`, "utf8")
    .digest("hex")}`;
}

function remoteMessage(chatId: string, messageId: string): RemoteEntry {
  return {
    entityKind: "message",
    entityId: messageEntityId(chatId, messageId),
    revision: 1,
    schemaVersion: 1,
    document: {
      version: 1,
      chatId,
      msgId: messageId,
      ord: 1,
      kind: "text",
      payload: JSON.stringify({ role: "assistant", text: "remote message" }),
      createdAt: NOW,
    },
    tombstonedAt: null,
  };
}

function remoteConversation(status: unknown): RemoteEntry[] {
  return [
    {
      entityKind: "chat",
      entityId: "chat-1",
      revision: 1,
      schemaVersion: 1,
      document: {
        version: 1,
        chat: {
          id: "chat-1",
          folder: ".",
          agentId: "codex",
          agentName: "Codex",
          model: "gpt-test",
          effort: "medium",
          permissionMode: "default",
          composerMode: "design",
          composerModeRevision: 7,
          lastModeId: null,
          prePlanModeId: null,
          fast: false,
          additionalDirectories: [],
          title: "Restored conversation",
          createdAt: NOW - 2_000,
          updatedAt: NOW - 1_000,
          sessionId: null,
          providerBinding: null,
          providerMetadata: null,
          pinned: false,
          archived: false,
          sourceChatId: null,
          kind: "code",
        },
      },
      tombstonedAt: null,
    },
    {
      entityKind: "turn",
      entityId: turnEntityId("chat-1", "turn-1"),
      revision: 2,
      schemaVersion: 1,
      document: {
        version: 1,
        row: {
          chat_id: "chat-1",
          turn_id: "turn-1",
          workspace_id: null,
          folder: ".",
          agent_id: "codex",
          ord: 1,
          summary: null,
          started_at: NOW - 1_000,
          ended_at: null,
          stop_reason: null,
          status,
          pre_snapshot: null,
          post_snapshot: null,
          files: null,
          usage: null,
        },
      },
      tombstonedAt: null,
    },
  ];
}

function localChat(id: string, folder: string, title: string) {
  return {
    id,
    folder,
    agentId: "codex",
    agentName: "Codex",
    model: "gpt-test",
    effort: "medium",
    permissionMode: "default",
    lastModeId: null,
    prePlanModeId: null,
    fast: false,
    additionalDirectories: [],
    title,
    createdAt: NOW - 2_000,
    updatedAt: NOW - 1_000,
    sessionId: null,
    providerBinding: null,
    providerMetadata: null,
    pinned: false,
    archived: false,
    sourceChatId: null,
    kind: "code" as const,
  };
}

function cloudReviewOwner(root: string, id = "local-main") {
  return {
    id, canonicalId: authority.workspaceId, organizationId: authority.organizationId,
    placement: "cloud" as const, repoRoot: root, path: root, repoSlug: "fixture",
    branch: "cloud/work", baseBranch: "main", status: "in-progress" as const,
    createdAt: NOW, archivedAt: null, stashRef: null, prNumber: null,
    prState: null, prUrl: null, agentId: null, lastActiveAt: null,
  };
}

function createRecordServer(initialEntries: readonly RemoteEntry[] = []) {
  let revision = initialEntries.reduce(
    (maximum, entry) => Math.max(maximum, entry.revision),
    0,
  );
  const remote = new Map(
    initialEntries.map((entry) => [
      `${entry.entityKind}\0${entry.entityId}`,
      structuredClone(entry),
    ]),
  );
  const appendBodies: Array<{
    expectedRevision: number;
    mutations: Array<{
      entityKind: string;
      entityId: string;
      schemaVersion: number;
      operation: "upsert" | "tombstone";
      document?: unknown;
      occurredAt: string;
    }>;
  }> = [];
  const requestFetch = vi.fn<typeof fetch>(async (request, init) => {
    const url = new URL(String(request));
    if (url.pathname.endsWith("/record/head")) {
      const afterKind = url.searchParams.get("afterEntityKind");
      const afterId = url.searchParams.get("afterEntityId");
      const after = afterKind && afterId ? `${afterKind}\0${afterId}` : null;
      const all = [...remote.values()].sort((a, b) =>
        `${a.entityKind}\0${a.entityId}`.localeCompare(
          `${b.entityKind}\0${b.entityId}`,
        ),
      );
      const remaining = all.filter(
          (entry) =>
            after === null || `${entry.entityKind}\0${entry.entityId}` > after,
        );
      const page = remaining.slice(0, 10);
      const last = page.at(-1);
      return Response.json({
        currentRevision: revision,
        entries: page,
        next: remaining.length > page.length && last
          ? { entityKind: last.entityKind, entityId: last.entityId } : null,
      });
    }
    const body = JSON.parse(
      String(init?.body),
    ) as (typeof appendBodies)[number];
    expect(body.expectedRevision).toBe(revision);
    appendBodies.push(body);
    for (const mutation of body.mutations) {
      revision += 1;
      remote.set(`${mutation.entityKind}\0${mutation.entityId}`, {
        entityKind: mutation.entityKind,
        entityId: mutation.entityId,
        revision,
        schemaVersion: mutation.schemaVersion,
        document: mutation.operation === "upsert" ? mutation.document : null,
        tombstonedAt:
          mutation.operation === "tombstone" ? mutation.occurredAt : null,
      });
    }
    return Response.json({
      firstRevision: body.expectedRevision + 1,
      lastRevision: revision,
      currentRevision: revision,
      replayed: false,
    });
  });
  const deleteChildren = () => {
    for(const [key,entry] of remote) if(entry.entityKind!=="chat")
      remote.set(key,{...entry,revision:++revision,document:null,tombstonedAt:new Date(NOW).toISOString()});
  };
  return { appendBodies, remote, requestFetch, deleteChildren };
}

const reviewHuman = { id: "fixture-human", name: "Fixture reviewer", kind: "human" as const };
const reviewAgent = { id: "fixture-session", name: "Codex", kind: "agent" as const, provider: "codex" };
async function captureReviewFixture(root: string, ownerId = "local-main") {
  insertWorkspace(cloudReviewOwner(root, ownerId));
  const input = { workspaceId: ownerId, requestId: "fixture-create",
    anchor: { path: "deleted/example.ts", side: "old" as const, startLine: 2, endLine: 3, revision: "fixture-old-revision" },
    body: "Fixture review" };
  const thread = codeReviewStore.create(input, reviewHuman);
  const server = createRecordServer();
  await new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize(authority);
  return { server, input, thread };
}

function reviewDocument(entries: readonly RemoteEntry[], kind: string): Record<string, unknown> {
  return entries.find((entry) => (entry.document as { kind?: string } | null)?.kind === kind)!.document as Record<string, unknown>;
}

const roots: string[] = [];

afterEach(async () => {
  closeZerosDb();
  setZerosDbPathForTesting(null);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("cloud durable record runtime", () => {
  it("revalidates an acknowledged projection without rereading every history page", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-page-cache-")); roots.push(root);
    setZerosDbPathForTesting(":memory:");
    const server = createRecordServer([
      ...remoteConversation("completed"),
      ...Array.from({ length: 205 }, (_, index) => {
        const entry = remoteMessage("chat-1", `message-${index}`);
        (entry.document as { ord: number }).ord = index + 1;
        return entry;
      }),
    ]);
    const runtime = new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch });
    const reads = () => server.requestFetch.mock.calls.filter(([url]) => String(url).includes('/record/head')).length;
    await runtime.synchronize(authority);
    expect(reads()).toBe(21);
    expect(windowChatMessages("chat-1", 1000)).toHaveLength(205);
    const before = reads();
    await runtime.synchronize(authority);
    expect(reads() - before).toBe(1);
    upsertChatMessage("chat-1", { msgId: "next-reply", kind: "text", payload: '{"role":"assistant","text":"hello"}', createdAt: NOW });
    await runtime.synchronize(authority);
    const afterAppend = reads();
    await runtime.synchronize(authority);
    expect(reads() - afterAppend).toBe(1);
    expect(windowChatMessages("chat-1", 1000)).toHaveLength(206);
    // An external revision invalidates the exact snapshot, including deletions.
    server.deleteChildren();
    const beforeDeletion = reads();
    await runtime.synchronize(authority);
    expect(reads() - beforeDeletion).toBeGreaterThan(1);
    expect(windowChatMessages("chat-1", 1000)).toEqual([]);
    const beforeReplacement = reads();
    await runtime.synchronize({ ...authority, generation: 2 });
    expect(reads() - beforeReplacement).toBeGreaterThan(1);
  });

  it("rereads the server after an append acknowledgement is lost", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-lost-cache-")); roots.push(root);
    setZerosDbPathForTesting(":memory:");
    const server = createRecordServer(remoteConversation("completed"));
    let loseAcknowledgement = false;
    const requestFetch = vi.fn<typeof fetch>(async (url, init) => {
      const response = await server.requestFetch(url, init);
      if (loseAcknowledgement && new URL(String(url)).pathname.endsWith('/record/append')) {
        loseAcknowledgement = false;
        throw Error('Lost acknowledgement');
      }
      return response;
    });
    const runtime = new CloudWorkspaceRecordRuntime(root, { fetch: requestFetch });
    await runtime.synchronize(authority);
    const before = server.appendBodies.length;
    upsertChatMessage("chat-1", { msgId: "new-reply", kind: "text", payload: '{"role":"assistant","text":"hello"}', createdAt: NOW });
    loseAcknowledgement = true;
    await expect(runtime.synchronize(authority)).rejects.toThrow('Lost acknowledgement');
    expect(server.appendBodies).toHaveLength(before + 1);
    await runtime.synchronize(authority);
    expect(server.appendBodies).toHaveLength(before + 1);
    expect(windowChatMessages("chat-1", 100)).toHaveLength(1);
  });

  it("does not restore a locally reset transcript and its deleted turns before publishing deletion", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-record-reset-"));roots.push(root);setZerosDbPathForTesting(":memory:");
    const server=createRecordServer([...remoteConversation("completed"),remoteMessage("chat-1","message-1")]);
    const runtime=new CloudWorkspaceRecordRuntime(root,{fetch:server.requestFetch});await runtime.synchronize(authority);
    clearChatMessages("chat-1");deleteTurnsFrom("chat-1","turn-1");
    await runtime.synchronize(authority);
    expect(windowChatMessages("chat-1",100)).toEqual([]);expect(getTurn("chat-1","turn-1")).toBeNull();
    for(const entry of server.remote.values())if(entry.entityKind!=="chat")expect(entry.tombstonedAt).not.toBeNull();
    await runtime.synchronize(authority);expect(windowChatMessages("chat-1",100)).toEqual([]);
    // Reset undo is intentional after the deletion receipt; it may re-use a
    // child's identity, unlike a permanently deleted conversation identity.
    upsertChatMessage("chat-1",{msgId:"message-1",kind:"text",payload:'{"role":"assistant","text":"restored"}',createdAt:NOW});
    await runtime.synchronize(authority);
    expect(windowChatMessages("chat-1",100)).toHaveLength(1);
    expect(server.remote.get(`message\0${messageEntityId("chat-1","message-1")}`)?.tombstonedAt).toBeNull();
  });
  it("applies newer remote child deletions even when an unrelated chat is locally dirty",async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),"zeros-record-child-delete-"));roots.push(root);setZerosDbPathForTesting(":memory:");
    const server=createRecordServer([...remoteConversation("completed"),remoteMessage("chat-1","message-1")]);
    const runtime=new CloudWorkspaceRecordRuntime(root,{fetch:server.requestFetch});await runtime.synchronize(authority);
    upsertChat(localChat("chat-2",root,"Dirty"));
    server.deleteChildren();
    await runtime.synchronize(authority);
    expect(windowChatMessages("chat-1",100)).toEqual([]);expect(getTurn("chat-1","turn-1")).toBeNull();
    expect(server.appendBodies.flatMap(body=>body.mutations).filter(m=>m.entityKind!=="chat"&&m.operation==="upsert")).toEqual([]);
  });
  it.each([false, true])("keeps a local deletion while publishing its durable tombstone (other chat=%s)", async otherChat => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-deleted-")); roots.push(root);
    setZerosDbPathForTesting(":memory:");
    const server = createRecordServer([...remoteConversation("completed"), remoteMessage("chat-1", "message-1")]);
    const runtime = new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch });
    await runtime.synchronize(authority);
    if (otherChat) { upsertChat(localChat("chat-2", root, "Keep")); await runtime.synchronize(authority); }
    deleteTurnsForChat("chat-1"); deleteChat("chat-1");
    await runtime.synchronize(authority);
    expect(listChats().map(chat => chat.id)).toEqual(otherChat ? ["chat-2"] : []);
    expect(wasChatDeleted("chat-1")).toBe(true);
    for (const entry of server.remote.values()) {
      if (entry.entityId !== "chat-2") expect(entry.tombstonedAt).not.toBeNull();
    }
    await runtime.synchronize(authority);
    expect(wasChatDeleted("chat-1")).toBe(true);
  });

  it("installs restored tombstones and rejects a locally dirty resurrection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-remote-delete-")); roots.push(root);
    setZerosDbPathForTesting(":memory:");
    const server = createRecordServer(remoteConversation("completed").map(entry => ({ ...entry, document: null, tombstonedAt: new Date(NOW).toISOString() })));
    const runtime = new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch });
    await runtime.synchronize(authority);
    expect(wasChatDeleted("chat-1")).toBe(true);
    // A stale historical client cannot make its dirty version outrank deletion.
    upsertChat(localChat("chat-1", root, "Stale write"));
    await runtime.synchronize(authority);
    expect(listChats()).toEqual([]);
    expect(wasChatDeleted("chat-1")).toBe(true);
    expect(server.appendBodies.flatMap(body => body.mutations)).toEqual([]);
  });
  it("commits a captured record revision while native streaming continues during upload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-streaming-")); roots.push(root);
    setZerosDbPathForTesting(":memory:");
    let update = 0;
    upsertChat(localChat("streaming-chat", root, "captured-0"));
    const server = createRecordServer();
    let streaming = true;
    const fetcher = vi.fn<typeof fetch>(async (request, init) => {
      const response = await server.requestFetch(request, init);
      if (new URL(String(request)).pathname.endsWith("/record/append") && streaming)
        upsertChat(localChat("streaming-chat", root, `captured-${++update}`));
      return response;
    });
    const runtime = new CloudWorkspaceRecordRuntime(root, { fetch: fetcher });
    await expect(runtime.synchronize(authority)).resolves.toBeUndefined();
    expect(server.appendBodies).toHaveLength(1);
    expect(listChats()[0].title).toBe("captured-1");
    expect(server.remote.get("chat\0streaming-chat")?.document).toMatchObject({ chat: { title: "captured-0" } });
    streaming = false;
    await runtime.synchronize(authority);
    expect(listChats()[0].title).toBe("captured-1");
    expect(server.remote.get("chat\0streaming-chat")?.document).toMatchObject({ chat: { title: "captured-1" } });
  });

  it("preserves conversations outside the synchronized repository during a clean restore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-owned-"));
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "zeros-record-outside-"),
    );
    roots.push(root, outside);
    setZerosDbPathForTesting(":memory:");
    const db = openZerosDb();
    upsertChat(localChat("outside-chat", outside, "Unrelated conversation"));
    upsertChatMessage("outside-chat", {
      msgId: "outside-message",
      kind: "text",
      payload: JSON.stringify({ role: "user", text: "keep me" }),
      createdAt: NOW,
    });
    startTurn({
      chatId: "outside-chat",
      turnId: "outside-turn",
      workspaceId: null,
      folder: outside,
      agentId: "codex",
      summary: null,
      startedAt: NOW,
      preSnapshot: null,
    });
    db.prepare(
      "INSERT INTO sync_tombstones (kind, id, rev) VALUES ('msgreset', ?, 500)",
    ).run("outside-chat");
    db.prepare(
      "INSERT INTO sync_tombstones (kind, id, rev) VALUES ('chat', ?, 501)",
    ).run("outside-deleted-chat");

    const server = createRecordServer(remoteConversation("completed"));
    await new CloudWorkspaceRecordRuntime(root, {
      fetch: server.requestFetch,
    }).synchronize(authority);

    expect(listChats()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "outside-chat",
          folder: outside,
          title: "Unrelated conversation",
        }),
        expect.objectContaining({ id: "chat-1", folder: root, composerMode: "design", composerModeRevision: 7 }),
      ]),
    );
    expect(listChatMessagesSince(0)).toContainEqual(
      expect.objectContaining({
        chatId: "outside-chat",
        msgId: "outside-message",
      }),
    );
    expect(getTurn("outside-chat", "outside-turn")).toMatchObject({
      folder: outside,
      status: "running",
    });
    expect(
      db
        .prepare("SELECT kind, id FROM sync_tombstones ORDER BY kind, id")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { kind: "chat", id: "outside-deleted-chat" },
        { kind: "msgreset", id: "outside-chat" },
      ]),
    );
  });

  it("fails closed when a remote conversation id belongs to another local repository", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zeros-record-collision-"),
    );
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "zeros-record-collision-outside-"),
    );
    roots.push(root, outside);
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    upsertChat(localChat("chat-1", outside, "Keep original"));
    const server = createRecordServer(remoteConversation("completed"));

    await expect(
      new CloudWorkspaceRecordRuntime(root, {
        fetch: server.requestFetch,
      }).synchronize(authority),
    ).rejects.toThrow("cloud chat identity belongs to another repository");
    expect(listChats()).toMatchObject([
      { id: "chat-1", folder: outside, title: "Keep original" },
    ]);
  });

  it("never admits an orphan remote child through an out-of-repository chat", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zeros-record-child-collision-"),
    );
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "zeros-record-child-collision-outside-"),
    );
    roots.push(root, outside);
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    upsertChat(localChat("owned-chat", root, "Owned conversation"));
    upsertChat(localChat("outside-chat", outside, "Keep original"));
    const server = createRecordServer([
      remoteMessage("outside-chat", "remote-message"),
    ]);

    await expect(
      new CloudWorkspaceRecordRuntime(root, {
        fetch: server.requestFetch,
      }).synchronize(authority),
    ).rejects.toThrow("cloud message document is invalid");
    expect(listChatMessagesSince(0)).not.toContainEqual(
      expect.objectContaining({
        chatId: "outside-chat",
        msgId: "remote-message",
      }),
    );
    expect(listChats()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "outside-chat",
          folder: outside,
          title: "Keep original",
        }),
      ]),
    );
  });

  it("retains missing-mode imports whose parent is locally owned", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zeros-record-owned-child-"),
    );
    roots.push(root);
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    upsertChat(localChat("owned-chat", root, "Owned conversation"));
    const server = createRecordServer([
      remoteMessage("owned-chat", "remote-message"),
    ]);

    await new CloudWorkspaceRecordRuntime(root, {
      fetch: server.requestFetch,
    }).synchronize(authority);

    expect(listChatMessagesSince(0)).toContainEqual(
      expect.objectContaining({
        chatId: "owned-chat",
        msgId: "remote-message",
      }),
    );
  });

  it("rejects a live remote child whose parent chat is tombstoned", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zeros-record-tombstoned-parent-"),
    );
    roots.push(root);
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    upsertChat(localChat("owned-chat", root, "Locally edited conversation"));
    const message = remoteMessage("owned-chat", "remote-message");
    message.revision = 2;
    const server = createRecordServer([
      {
        entityKind: "chat",
        entityId: "owned-chat",
        revision: 1,
        schemaVersion: 1,
        document: null,
        tombstonedAt: "2026-09-04T11:59:00.000Z",
      },
      message,
    ]);

    await expect(
      new CloudWorkspaceRecordRuntime(root, {
        fetch: server.requestFetch,
      }).synchronize(authority),
    ).rejects.toThrow("cloud message document is invalid");
    expect(listChats()).toMatchObject([
      { id: "owned-chat", title: "Locally edited conversation" },
    ]);
    expect(listChatMessagesSince(0)).toEqual([]);
  });

  it("writes through chats and restores them before a fresh engine becomes ready", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-runtime-"));
    roots.push(root);
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    upsertChat({
      id: "chat-1",
      folder: root,
      agentId: "codex",
      agentName: "Codex",
      model: "gpt-test",
      effort: "medium",
      permissionMode: "default",
      lastModeId: null,
      prePlanModeId: null,
      fast: false,
      additionalDirectories: ["/private/never-sync"],
      title: "Durable conversation",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      sessionId: null,
      providerBinding: null,
      providerMetadata: null,
      pinned: false,
      archived: false,
      sourceChatId: null,
      kind: "code",
    });
    upsertChatMessage("chat-1", {
      msgId: "message-a",
      kind: "text",
      payload: JSON.stringify({ role: "user", text: "first" }),
      createdAt: 1_700_000_000_050,
    });
    upsertChatMessage("chat-1", {
      msgId: "message-b",
      kind: "text",
      payload: JSON.stringify({ role: "assistant", text: "second" }),
      createdAt: 1_700_000_000_075,
    });

    const server = createRecordServer();

    await new CloudWorkspaceRecordRuntime(root, {
      fetch: server.requestFetch,
    }).synchronize(authority);
    expect(
      [...server.remote.values()].map((entry) => entry.entityKind).sort(),
    ).toEqual(["chat", "message", "message"]);
    expect(JSON.stringify([...server.remote.values()])).not.toContain(
      "/private/never-sync",
    );

    closeZerosDb();
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    await new CloudWorkspaceRecordRuntime(root, {
      fetch: server.requestFetch,
    }).synchronize(authority);
    expect(listChats()).toMatchObject([
      { id: "chat-1", folder: root, title: "Durable conversation" },
    ]);
    expect(listChatMessagesSince(0)).toMatchObject([
      { chatId: "chat-1", msgId: "message-a" },
      { chatId: "chat-1", msgId: "message-b" },
    ]);
  });

  it("restores review history, authors, resolution and retry receipts in a replacement allocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-reviews-"));
    const replacement = await mkdtemp(path.join(os.tmpdir(), "zeros-record-reviews-next-"));
    roots.push(root, replacement);
    for (const folder of [root, replacement]) {
      await mkdir(path.join(folder, "src"));
      await writeFile(path.join(folder, "src/example.ts"), "export const fixture = 1;\n");
    }
    setZerosDbPathForTesting(":memory:");
    insertWorkspace(cloudReviewOwner(root));
    const human = { id: "reviewer-1", name: "Fixture reviewer", kind: "human" as const };
    const agent = { id: "session-1", name: "Codex", kind: "agent" as const, provider: "codex" };
    const integration = { id: "integration-1", name: "Fixture integration", kind: "integration" as const };
    const createInput = {
      workspaceId: "local-main", requestId: "durable-create",
      anchor: { path: "src/example.ts", side: "file" as const, startLine: 1, endLine: 1,
        revision: "fixture-original-content", context: "export const fixture = 1;" },
      body: "Original fixture comment",
    };
    let thread = codeReviewStore.create(createInput, human);
    const replyInput = {
      workspaceId: "local-main", threadId: thread.id, body: "Agent fixture reply", requestId: "durable-reply",
    };
    thread = codeReviewStore.reply(replyInput, agent);
    for (let index = 0; index < 130; index++) {
      thread = codeReviewStore.reply({ workspaceId: "local-main", threadId: thread.id,
        body: `Ordered fixture reply ${index}`, requestId: `durable-reply-${index}` }, integration);
    }
    const resolveInput = { workspaceId: "local-main", threadId: thread.id,
      resolved: true, expectedVersion: thread.version, requestId: "durable-resolve" };
    thread = codeReviewStore.setResolved(resolveInput, human);
    const comments = openZerosDb().prepare("SELECT * FROM code_review_comments ORDER BY seq").all();
    const receipts = openZerosDb().prepare("SELECT * FROM code_review_requests ORDER BY actor_key, request_id").all();
    // A thread under an unrelated semantic owner must never join this record.
    codeReviewStore.create({ ...createInput, workspaceId: "outside-owner", requestId: "outside-create" }, human);
    const server = createRecordServer();
    await new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize(authority);

    closeZerosDb();
    setZerosDbPathForTesting(":memory:");
    insertWorkspace(cloudReviewOwner(replacement));
    await new CloudWorkspaceRecordRuntime(replacement, { fetch: server.requestFetch }).synchronize({
      ...authority, generation: 2, engineInstanceId: "55555555-5555-4555-8555-555555555555",
    });
    expect(codeReviewStore.list({ workspaceId: "local-main" }).threads).toMatchObject([
      { id: thread.id, anchor: thread.anchor, resolved: true, version: thread.version,
        commentCount: 132, resolvedBy: human, resolvedAt: thread.resolvedAt },
    ]);
    expect(openZerosDb().prepare("SELECT * FROM code_review_comments ORDER BY seq").all()).toEqual(comments);
    expect(openZerosDb().prepare("SELECT * FROM code_review_requests ORDER BY actor_key, request_id").all()).toEqual(receipts);
    expect(codeReviewStore.list({ workspaceId: "outside-owner" }).threads).toEqual([]);
    expect(codeReviewStore.create(createInput, human).id).toBe(thread.id);
    expect(codeReviewStore.reply(replyInput, agent).version).toBe(thread.version);
    expect(codeReviewStore.setResolved(resolveInput, human).version).toBe(thread.version);
    expect(() => codeReviewStore.setResolved({ ...resolveInput, requestId: "stale-reopen", resolved: false }, human))
      .toThrow("This review thread changed");
    expect(codeReviewStore.setResolved({ ...resolveInput, expectedVersion: thread.version,
      requestId: "durable-reopen", resolved: false }, agent)).toMatchObject({ resolved: false, version: thread.version + 1 });
    expect(() => openZerosDb().prepare("UPDATE code_review_comments SET author_json = ? WHERE id = ?")
      .run(JSON.stringify(integration), thread.comments[0].id)).toThrow("Review comments are immutable");
    expect(await readFile(path.join(replacement, "src/example.ts"), "utf8")).toBe("export const fixture = 1;\n");
    for (const body of server.appendBodies) {
      expect(body.mutations.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(2 * 1024 * 1024);
      for (const mutation of body.mutations) {
        expect(Buffer.byteLength(JSON.stringify(mutation.document))).toBeLessThanOrEqual(512 * 1024);
      }
    }
  });

  it("restores the cloud primary workspace's target branch, mode and PR after a worker replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-metadata-"));
    roots.push(root);
    const primary = { id: "local-main", canonicalId: authority.workspaceId, organizationId: authority.organizationId, placement: "cloud" as const,
      repoRoot: root, path: root, repoSlug: "fixture", branch: "cloud/work", baseBranch: "main", status: "in-progress" as const, createdAt: NOW,
      archivedAt: null, stashRef: null, prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null };
    setZerosDbPathForTesting(":memory:"); openZerosDb(); insertWorkspace(primary);
    updateWorkspace("local-main", { baseBranch: "release", viewMode: "design", prNumber: 42, prState: "draft", prUrl: "https://github.com/example/fixture/pull/42" });
    const server = createRecordServer();
    await new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize(authority);
    closeZerosDb(); setZerosDbPathForTesting(":memory:"); openZerosDb(); insertWorkspace(primary);
    await new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize(authority);
    expect(getWorkspaceById("local-main")).toMatchObject({ ...primary, baseBranch: "release", viewMode: "design", prNumber: 42, prState: "draft", prUrl: "https://github.com/example/fixture/pull/42" });
  });

  it("remaps the canonical review owner while preserving retries, actors and comment order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-remap-"));
    const replacement = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-remap-next-"));
    roots.push(root, replacement);
    setZerosDbPathForTesting(":memory:");
    const { server, input, thread } = await captureReviewFixture(root, "previous-route");
    const replyInput = { workspaceId: "previous-route", threadId: thread.id, requestId: "remap-reply", body: "Reply before replacement" };
    const replied = codeReviewStore.reply(replyInput, reviewAgent);
    const resolveInput = { workspaceId: "previous-route", threadId: thread.id, requestId: "remap-resolve", resolved: true, expectedVersion: replied.version };
    const resolved = codeReviewStore.setResolved(resolveInput, reviewHuman);
    await new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize(authority);
    closeZerosDb(); setZerosDbPathForTesting(":memory:");
    insertWorkspace(cloudReviewOwner(replacement, "replacement-route"));
    await new CloudWorkspaceRecordRuntime(replacement, { fetch: server.requestFetch }).synchronize({ ...authority, generation: 2 });
    const restored = codeReviewStore.get("replacement-route", thread.id);
    expect(restored).toEqual({ ...resolved, workspaceId: "replacement-route" });
    expect(restored.comments.map((comment) => [comment.sequence, comment.author])).toEqual([[1, reviewHuman], [2, reviewAgent]]);
    expect(codeReviewStore.create({ ...input, workspaceId: "replacement-route" }, reviewHuman).id).toBe(thread.id);
    expect(codeReviewStore.reply({ ...replyInput, workspaceId: "replacement-route" }, reviewAgent).version).toBe(3);
    expect(codeReviewStore.setResolved({ ...resolveInput, workspaceId: "replacement-route" }, reviewHuman).version).toBe(3);
    expect(codeReviewStore.list({ workspaceId: "previous-route" }).threads).toEqual([]);
    expect(openZerosDb().prepare("SELECT DISTINCT workspace_id FROM code_review_requests").all()).toEqual([{ workspace_id: "replacement-route" }]);
  });

  it("keeps replies added during a record upload dirty until the next durable capture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-stream-")); roots.push(root);
    setZerosDbPathForTesting(":memory:");
    const { server, thread } = await captureReviewFixture(root);
    codeReviewStore.reply({ workspaceId: "local-main", threadId: thread.id, body: "Captured reply" }, reviewAgent);
    let appendWhileUploading = true;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const response = await server.requestFetch(url, init);
      if (appendWhileUploading && new URL(String(url)).pathname.endsWith("/record/append")) {
        appendWhileUploading = false;
        codeReviewStore.reply({ workspaceId: "local-main", threadId: thread.id, body: "Concurrent reply" }, reviewHuman);
      }
      return response;
    });
    const runtime = new CloudWorkspaceRecordRuntime(root, { fetch: fetcher });
    await runtime.synchronize(authority);
    expect(codeReviewStore.get("local-main", thread.id)).toMatchObject({ version: 3, commentCount: 3 });
    expect(reviewDocument([...server.remote.values()], "thread")).toMatchObject({ thread: { version: 2, commentCount: 2 } });
    await runtime.synchronize(authority);
    expect(reviewDocument([...server.remote.values()], "thread")).toMatchObject({ thread: { version: 3, commentCount: 3 } });
    expect(codeReviewStore.get("local-main", thread.id).comments.map((comment) => comment.body))
      .toEqual(["Fixture review", "Captured reply", "Concurrent reply"]);
  });

  it("flushes acknowledged replies after a held heartbeat capture before allocation replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-final-flush-")); roots.push(root);
    setZerosDbPathForTesting(":memory:");
    const { server, thread } = await captureReviewFixture(root);
    codeReviewStore.reply({ workspaceId: "local-main", threadId: thread.id, body: "Reply A", requestId: "final-reply-a" }, reviewAgent);
    let releaseUpload!: () => void;
    let notifyUpload!: () => void;
    const heldUpload = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const uploadEntered = new Promise<void>((resolve) => { notifyUpload = resolve; });
    let holdNextUpload = true;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (holdNextUpload && new URL(String(url)).pathname.endsWith("/record/append")) {
        holdNextUpload = false;
        notifyUpload();
        await heldUpload;
      }
      return server.requestFetch(url, init);
    });
    const runtime = new CloudWorkspaceRecordRuntime(root, { fetch: fetcher });
    const heartbeat = runtime.synchronize(authority);
    await uploadEntered;
    codeReviewStore.reply({ workspaceId: "local-main", threadId: thread.id, body: "Reply B", requestId: "final-reply-b" }, reviewHuman);
    // Final lifecycle admission is quiescent at this point. A pre-existing
    // heartbeat captured A before the acknowledged B write reached SQLite.
    const finalCapture = runtime.flush(authority);
    releaseUpload();
    await Promise.all([heartbeat, finalCapture]);
    closeZerosDb(); setZerosDbPathForTesting(":memory:"); insertWorkspace(cloudReviewOwner(root));
    await new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize({ ...authority, generation: 2 });
    const restored = codeReviewStore.get("local-main", thread.id);
    expect(restored).toMatchObject({ version: 3, commentCount: 3 });
    expect(restored.comments.map((comment) => comment.body)).toEqual(["Fixture review", "Reply A", "Reply B"]);
    expect(restored.comments.map((comment) => comment.author)).toEqual([reviewHuman, reviewAgent, reviewHuman]);
    expect(openZerosDb().prepare("SELECT COUNT(*) AS count FROM code_review_requests").get()).toEqual({ count: 3 });
  });

  it("captures scoped agent tool writes through the same durable record lifecycle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-agent-")); roots.push(root);
    setZerosDbPathForTesting(":memory:"); insertWorkspace(cloudReviewOwner(root));
    const tools = new CodeReviewAgentTools({ workspaceId: "local-main", workspacePath: root, assertCurrent: vi.fn() }, {
      resolveReadCwd: () => root, ownerRoots: () => [root],
    }, reviewAgent);
    const signal = new AbortController().signal;
    await tools.callTool("code_review_create", {
      anchor: { path: "deleted/agent.ts", side: "old", startLine: 1, endLine: 1, revision: "fixture-agent-revision" },
      body: "Scoped agent fixture comment", requestId: "scoped-agent-create",
    }, signal);
    const thread = codeReviewStore.list({ workspaceId: "local-main" }).threads[0]!;
    await tools.callTool("code_review_reply", { threadId: thread.id, body: "Scoped agent fixture reply", requestId: "scoped-agent-reply" }, signal);
    await tools.callTool("code_review_set_resolved", { threadId: thread.id, resolved: true, expectedVersion: 2, requestId: "scoped-agent-resolve" }, signal);
    const server = createRecordServer();
    await new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize(authority);
    closeZerosDb(); setZerosDbPathForTesting(":memory:"); insertWorkspace(cloudReviewOwner(root));
    await new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize({ ...authority, generation: 2 });
    const restored = codeReviewStore.get("local-main", thread.id);
    expect(restored).toMatchObject({ version: 3, commentCount: 2, resolved: true, resolvedBy: reviewAgent });
    expect(restored.comments.map((comment) => [comment.sequence, comment.author])).toEqual([[1, reviewAgent], [2, reviewAgent]]);
    expect(openZerosDb().prepare("SELECT COUNT(*) AS count FROM code_review_requests").get()).toEqual({ count: 3 });
  });

  it("restores the last committed review after an interrupted multibatch upload and permits a safe retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-interrupted-"));
    const replacement = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-interrupted-next-"));
    roots.push(root, replacement);
    setZerosDbPathForTesting(":memory:");
    const { server, input, thread } = await captureReviewFixture(root);
    const replyInput = { workspaceId: "local-main", threadId: thread.id, requestId: "interrupted-reply-0", body: "Pending fixture reply 0" };
    for (let index = 0; index < 140; index++) codeReviewStore.reply({ ...replyInput,
      requestId: `interrupted-reply-${index}`, body: `Pending fixture reply ${index}` }, reviewAgent);
    let appended = 0;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const response = await server.requestFetch(url, init);
      if (new URL(String(url)).pathname.endsWith("/record/append") && ++appended === 2) throw new Error("Fixture upload interrupted");
      return response;
    });
    await expect(new CloudWorkspaceRecordRuntime(root, { fetch: fetcher }).synchronize(authority)).rejects.toThrow("Fixture upload interrupted");
    expect(reviewDocument([...server.remote.values()], "thread")).toMatchObject({ thread: { version: 1, commentCount: 1 } });
    expect([...server.remote.values()].filter((entry) => (entry.document as { kind?: string } | null)?.kind === "request").length).toBeGreaterThan(1);
    closeZerosDb(); setZerosDbPathForTesting(":memory:"); insertWorkspace(cloudReviewOwner(replacement));
    const runtime = new CloudWorkspaceRecordRuntime(replacement, { fetch: server.requestFetch });
    await runtime.synchronize({ ...authority, generation: 2 });
    expect(codeReviewStore.get("local-main", thread.id)).toEqual(thread);
    expect(codeReviewStore.create(input, reviewHuman).id).toBe(thread.id);
    expect(openZerosDb().prepare("SELECT COUNT(*) AS count FROM code_review_requests").get()).toEqual({ count: 1 });
    expect([...server.remote.values()].filter((entry) => entry.document &&
      ["comment", "request"].includes((entry.document as { kind: string }).kind))).toHaveLength(2);
    expect(codeReviewStore.reply(replyInput, reviewAgent)).toMatchObject({ version: 2, commentCount: 2 });
    await runtime.synchronize({ ...authority, generation: 2 });
    closeZerosDb(); setZerosDbPathForTesting(":memory:"); insertWorkspace(cloudReviewOwner(replacement));
    await new CloudWorkspaceRecordRuntime(replacement, { fetch: server.requestFetch }).synchronize({ ...authority, generation: 3 });
    expect(codeReviewStore.get("local-main", thread.id).comments.map((comment) => comment.body)).toEqual(["Fixture review", "Pending fixture reply 0"]);
    expect(codeReviewStore.reply(replyInput, reviewAgent).commentCount).toBe(2);
  });

  it.each([
    ["workspace binding", "thread", (document: Record<string, unknown>) => { document.workspaceId = "99999999-9999-4999-8999-999999999999"; }],
    ["organization binding", "comment", (document: Record<string, unknown>) => { document.organizationId = "99999999-9999-4999-8999-999999999999"; }],
    ["author", "comment", (document: Record<string, unknown>) => { (document.comment as { author: unknown }).author = { ...reviewHuman, kind: "untrusted" }; }],
    ["line range", "thread", (document: Record<string, unknown>) => { ((document.thread as { anchor: { endLine: number } }).anchor).endLine = 1; }],
    ["path", "thread", (document: Record<string, unknown>) => { ((document.thread as { anchor: { path: string } }).anchor).path = "../outside.ts"; }],
    ["comment order", "comment", (document: Record<string, unknown>) => { (document.comment as { sequence: number }).sequence = 2; }],
    ["version", "thread", (document: Record<string, unknown>) => { (document.thread as { version: number }).version = 0; }],
    ["retry receipt", "request", (document: Record<string, unknown>) => { document.actorKey = '["human","spoofed"]'; }],
  ])("rejects a malformed restored review %s without partial import", async (_label, kind, corrupt) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-invalid-")); roots.push(root);
    setZerosDbPathForTesting(":memory:");
    const { server } = await captureReviewFixture(root);
    const entries = structuredClone([...server.remote.values()]);
    corrupt(reviewDocument(entries, kind));
    closeZerosDb(); setZerosDbPathForTesting(":memory:"); insertWorkspace(cloudReviewOwner(root));
    const malformed = createRecordServer(entries);
    await expect(new CloudWorkspaceRecordRuntime(root, { fetch: malformed.requestFetch }).synchronize({ ...authority, generation: 2 }))
      .rejects.toThrow("cloud review document is invalid");
    expect(codeReviewStore.list({ workspaceId: "local-main" }).threads).toEqual([]);
    expect(openZerosDb().prepare("SELECT COUNT(*) AS count FROM code_review_requests").get()).toEqual({ count: 0 });
    expect(malformed.appendBodies).toEqual([]);
  });

  it("fails closed on a review thread identity belonging to a different local workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-collision-")); roots.push(root);
    setZerosDbPathForTesting(":memory:");
    const { server, thread } = await captureReviewFixture(root);
    closeZerosDb(); setZerosDbPathForTesting(":memory:"); insertWorkspace(cloudReviewOwner(root));
    openZerosDb().prepare("INSERT INTO code_review_threads (id, workspace_id, file_path, anchor_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(thread.id, "different-owner", thread.anchor.path, JSON.stringify(thread.anchor), thread.createdAt, thread.updatedAt);
    await expect(new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize({ ...authority, generation: 2 }))
      .rejects.toThrow("cloud review identity belongs to another workspace");
    expect(openZerosDb().prepare("SELECT workspace_id FROM code_review_threads WHERE id = ?").get(thread.id)).toEqual({ workspace_id: "different-owner" });
    expect(openZerosDb().prepare("SELECT COUNT(*) AS count FROM code_review_comments").get()).toEqual({ count: 0 });
  });

  it("rejects changes to an existing immutable review author", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-author-")); roots.push(root);
    setZerosDbPathForTesting(":memory:");
    const { server, thread } = await captureReviewFixture(root);
    const entries = structuredClone([...server.remote.values()]);
    (reviewDocument(entries, "comment").comment as { author: unknown }).author = reviewAgent;
    const changed = createRecordServer(entries);
    await expect(new CloudWorkspaceRecordRuntime(root, { fetch: changed.requestFetch }).synchronize(authority))
      .rejects.toThrow("cloud review immutable comment changed");
    expect(codeReviewStore.get("local-main", thread.id).comments[0]!.author).toEqual(reviewHuman);
    expect(changed.appendBodies).toEqual([]);
  });

  it("keeps protected and aliased review context out of durable capture and preserves historical paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-policy-")); roots.push(root);
    setZerosDbPathForTesting(":memory:"); insertWorkspace(cloudReviewOwner(root));
    await writeFile(path.join(root, ".env"), "SYNTHETIC_FIXTURE_ONLY=1\n");
    await symlink(".env", path.join(root, "public-alias.txt"));
    const paths = [".env", "public-alias.txt", ".zeros/review.txt", ".conductor/review.txt", "nested/review.ts"];
    insertWorkspace({ ...cloudReviewOwner(path.join(root, "nested"), "nested-owner"),
      canonicalId: "77777777-7777-4777-8777-777777777777", placement: "local", branch: "nested/work" });
    const input = { workspaceId: "local-main", body: "Synthetic fixture comment",
      anchor: { path: "deleted/example.ts", side: "old" as const, startLine: 1, endLine: 1, revision: "fixture-historical" } };
    const historical = codeReviewStore.create(input, reviewHuman);
    for (const [index, file] of paths.entries()) codeReviewStore.create({ ...input, requestId: `protected-${index}`,
      anchor: { ...input.anchor, path: file, context: "SYNTHETIC_PRIVATE_CONTEXT" } }, reviewHuman);
    const server = createRecordServer();
    await new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize(authority);
    const records = [...server.remote.values()].filter((entry) => entry.entityId.startsWith("code-review-v1:"));
    expect(records).toHaveLength(2);
    expect(reviewDocument(records, "thread")).toMatchObject({ thread: { id: historical.id, anchor: input.anchor } });
    expect(JSON.stringify(records)).not.toContain("SYNTHETIC_PRIVATE_CONTEXT");
    expect(codeReviewStore.list({ workspaceId: "local-main" }).threads).toHaveLength(6);
  });

  it.each([".env", "public-alias.txt", ".zeros/history.txt", ".conductor/history.txt"])(
    "retains a durable protected %s anchor without importing its context", async (file) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-protected-")); roots.push(root);
      setZerosDbPathForTesting(":memory:");
      const { server } = await captureReviewFixture(root);
      const entries = structuredClone([...server.remote.values()]);
      const header = reviewDocument(entries, "thread").thread as { anchor: { path: string; context?: string } };
      header.anchor.path = file; header.anchor.context = "SYNTHETIC_PRIVATE_CONTEXT";
      await writeFile(path.join(root, ".env"), "SYNTHETIC_FIXTURE_ONLY=1\n");
      await symlink(".env", path.join(root, "public-alias.txt"));
      closeZerosDb(); setZerosDbPathForTesting(":memory:"); insertWorkspace(cloudReviewOwner(root));
      const protectedServer = createRecordServer(entries);
      await new CloudWorkspaceRecordRuntime(root, { fetch: protectedServer.requestFetch }).synchronize({ ...authority, generation: 2 });
      expect(codeReviewStore.list({ workspaceId: "local-main" }).threads).toEqual([]);
      expect(protectedServer.appendBodies).toEqual([]);
      expect(reviewDocument([...protectedServer.remote.values()], "thread")).toMatchObject({ thread: { anchor: header.anchor } });
    },
  );

  it("rejects restore when the canonical owner is registered at another checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-owner-path-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "zeros-record-review-owner-path-other-"));
    roots.push(root, outside); setZerosDbPathForTesting(":memory:");
    const { server } = await captureReviewFixture(root);
    closeZerosDb(); setZerosDbPathForTesting(":memory:"); insertWorkspace(cloudReviewOwner(outside));
    await expect(new CloudWorkspaceRecordRuntime(root, { fetch: server.requestFetch }).synchronize({ ...authority, generation: 2 }))
      .rejects.toThrow("cloud review workspace identity changed");
    expect(codeReviewStore.list({ workspaceId: "local-main" }).threads).toEqual([]);
  });

  it.each([
    ["an array", ["running"]],
    ["a number", 1],
  ])("rejects %s used as a remote turn status", async (_label, status) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-status-"));
    roots.push(root);
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    const server = createRecordServer(remoteConversation(status));

    await expect(
      new CloudWorkspaceRecordRuntime(root, {
        fetch: server.requestFetch,
      }).synchronize(authority),
    ).rejects.toThrow("cloud turn document is invalid");
    expect(getTurn("chat-1", "turn-1")).toBeNull();
  });

  it("settles a running turn restored by the startup sync before readiness and writes the correction back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-record-startup-"));
    roots.push(root);
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    const server = createRecordServer(remoteConversation("running"));
    const recordRuntime = new CloudWorkspaceRecordRuntime(root, {
      fetch: server.requestFetch,
      now: () => NOW,
    });
    const config: CloudRuntimeConfig = {
      version: 1,
      audience: "zeros-cloud-engine-runtime-v1",
      execution: {
        workspaceId: authority.workspaceId,
        organizationId: authority.organizationId,
        generation: authority.generation,
        setupRunId: "44444444-4444-4444-8444-444444444444",
        executionFence: 1,
      },
      engine: {
        instanceId: authority.engineInstanceId,
        protocolVersion: 1,
        readinessProbeToken: `zwr_${"r".repeat(43)}`,
      },
      registration: {
        endpoint:
          "https://control.example.test/internal/v1/cloud-workspaces/engine/register",
        token: `zws_${"s".repeat(43)}`,
        expiresAtMs: NOW + 60_000,
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/engine/register")) {
        return Response.json({
          version: 1,
          audience: "zeros-cloud-workspace-engine-registration-v1",
          engineInstanceId: authority.engineInstanceId,
          durableRecordConnected: true,
          leaseExpiresAtMs: NOW + 90_000,
          heartbeat: {
            endpoint: authority.heartbeatEndpoint,
            token: authority.heartbeatToken,
            intervalMs: 30_000,
          },
        });
      }
      return server.requestFetch(request, init);
    });
    const registration: CloudRuntimeRegistration = new CloudRuntimeRegistration(
      config,
      { agentRuntime: {
          profile: "zeros-cloud-worker-v4", runtimeId: testCloudRuntime().runtimeId,
          manifestSha256: testCloudRuntime().manifestSha256, baseCompatibilityId: testCloudRuntime().baseCompatibilityId,
          installerReceiptSha256: testCloudRuntime().installerReceiptSha256, bootId: testCloudRuntime().bootId,
          supervisorSessionId: testCloudRuntime().supervisorSessionId,
        },
        fetch,
        now: () => NOW,
        onAuthorityLost: vi.fn(),
        onDurableRecordSync: async (syncAuthority, context) => {
          await recordRuntime.synchronize(syncAuthority, {
            settleImportedRunningTurns: context.initial,
          });
          expect(registration.readiness()).toBeNull();
        },
      },
    );

    await registration.start();

    expect(getTurn("chat-1", "turn-1")).toMatchObject({
      status: "failed",
      endedAt: NOW,
      stopReason: null,
      files: [],
    });
    expect(
      server.remote.get(`turn\0${turnEntityId("chat-1", "turn-1")}`)?.document,
    ).toMatchObject({
      row: {
        status: "failed",
        ended_at: NOW,
        stop_reason: null,
        files: "[]",
      },
    });
    expect(
      server.appendBodies.flatMap((body) => body.mutations),
    ).toContainEqual(
      expect.objectContaining({
        entityKind: "turn",
        entityId: turnEntityId("chat-1", "turn-1"),
        operation: "upsert",
      }),
    );
    expect(registration.readiness()?.durableRecordConnected).toBe(true);
    await registration.stop();
  });

  it("preserves a running turn imported by an ordinary durable sync", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zeros-record-periodic-"),
    );
    roots.push(root);
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    const server = createRecordServer(remoteConversation("running"));

    await new CloudWorkspaceRecordRuntime(root, {
      fetch: server.requestFetch,
      now: () => NOW,
    }).synchronize(authority, { settleImportedRunningTurns: false });

    expect(getTurn("chat-1", "turn-1")).toMatchObject({
      status: "running",
      endedAt: null,
    });
    expect(server.appendBodies).toHaveLength(0);
  });
});
