import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudWorkspaceRecordRuntime } from "../cloud-record-runtime";
import { closeZerosDb, openZerosDb, setZerosDbPathForTesting } from "../db";
import { listChats, upsertChat } from "../db/chats";
import { listChatMessagesSince, upsertChatMessage } from "../db/messages";

const roots: string[] = [];

afterEach(async () => {
  closeZerosDb();
  setZerosDbPathForTesting(null);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("cloud durable record runtime", () => {
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

    let revision = 0;
    const remote = new Map<
      string,
      {
        entityKind: string;
        entityId: string;
        revision: number;
        schemaVersion: number;
        document: unknown;
        tombstonedAt: string | null;
      }
    >();
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
        return Response.json({ currentRevision: revision, entries: page, next: null });
      }
      const body = JSON.parse(String(init?.body)) as {
        expectedRevision: number;
        mutations: Array<{
          entityKind: string;
          entityId: string;
          schemaVersion: number;
          operation: "upsert" | "tombstone";
          document?: unknown;
          occurredAt: string;
        }>;
      };
      expect(body.expectedRevision).toBe(revision);
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
    const authority = {
      heartbeatEndpoint:
        "https://control.example.test/internal/v1/cloud-workspaces/engine/heartbeat",
      heartbeatToken: `zwh_${"h".repeat(43)}`,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      organizationId: "22222222-2222-4222-8222-222222222222",
      generation: 1,
      engineInstanceId: "33333333-3333-4333-8333-333333333333",
    };

    await new CloudWorkspaceRecordRuntime(root, { fetch: requestFetch }).synchronize(
      authority,
    );
    expect([...remote.values()].map((entry) => entry.entityKind).sort()).toEqual([
      "chat",
      "message",
      "message",
    ]);
    expect(JSON.stringify([...remote.values()])).not.toContain(
      "/private/never-sync",
    );

    closeZerosDb();
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    await new CloudWorkspaceRecordRuntime(root, { fetch: requestFetch }).synchronize(
      authority,
    );
    expect(listChats()).toMatchObject([
      { id: "chat-1", folder: root, title: "Durable conversation" },
    ]);
    expect(listChatMessagesSince(0)).toMatchObject([
      { chatId: "chat-1", msgId: "message-a" },
      { chatId: "chat-1", msgId: "message-b" },
    ]);
  });
});
