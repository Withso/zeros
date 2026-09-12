import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudWorkspaceRecordRuntime } from "../cloud-record-runtime";
import {
  CloudRuntimeRegistration,
  type CloudRuntimeConfig,
} from "../cloud-runtime-registration";
import { closeZerosDb, openZerosDb, setZerosDbPathForTesting } from "../db";
import { listChats, upsertChat } from "../db/chats";
import { listChatMessagesSince, upsertChatMessage } from "../db/messages";
import { getTurn, startTurn } from "../db/turns";

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
      const page = all
        .filter(
          (entry) =>
            after === null || `${entry.entityKind}\0${entry.entityId}` > after,
        )
        .slice(0, 10);
      return Response.json({
        currentRevision: revision,
        entries: page,
        next: null,
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
  return { appendBodies, remote, requestFetch };
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
        expect.objectContaining({ id: "chat-1", folder: root }),
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
      {
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
