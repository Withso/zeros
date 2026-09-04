import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  exportCloudWorkspaceForkRecords,
  forkedChatId,
  importCloudWorkspaceForkRecords,
  type CloudWorkspaceForkRecordEvent,
} from "../cloud-workspace-fork-records";
import { closeZerosDb, openZerosDb, setZerosDbPathForTesting } from "../db";
import { getChat, upsertChat } from "../db/chats";
import { upsertChatMessage, windowChatMessages } from "../db/messages";
import { getTurn, reinsertTurns } from "../db/turns";

const roots: string[] = [];

afterEach(async () => {
  closeZerosDb();
  setZerosDbPathForTesting(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  roots.push(root);
  return root;
}

function forkEventsWithTurnStatus(
  status: unknown,
): CloudWorkspaceForkRecordEvent[] {
  const chatId = "source-chat";
  const turnId = "turn-1";
  const occurredAt = "2026-08-30T12:00:00.000Z";
  return [
    {
      revision: 1,
      entityKind: "chat",
      entityId: chatId,
      operation: "upsert",
      schemaVersion: 1,
      occurredAt,
      document: {
        version: 1,
        chat: {
          id: chatId,
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
          title: "Copied chat",
          createdAt: 100,
          updatedAt: 200,
          sessionId: null,
          providerBinding: null,
          providerMetadata: null,
          pinned: false,
          archived: false,
          sourceChatId: null,
          kind: "code",
        },
      },
    },
    {
      revision: 2,
      entityKind: "turn",
      entityId: `t:${createHash("sha256")
        .update(`${chatId}\0${turnId}`, "utf8")
        .digest("hex")}`,
      operation: "upsert",
      schemaVersion: 1,
      occurredAt,
      document: {
        version: 1,
        row: {
          chat_id: chatId,
          turn_id: turnId,
          workspace_id: null,
          folder: ".",
          agent_id: "codex",
          ord: 1,
          summary: null,
          started_at: 100,
          ended_at: null,
          stop_reason: null,
          status,
          pre_snapshot: null,
          post_snapshot: null,
          files: null,
          usage: null,
        },
      },
    },
  ];
}

describe("portable workspace fork records", () => {
  it("remaps conversations and strips provider, host-path, snapshot, and live-run authority", async () => {
    const source = await tempRoot("zeros-fork-source-");
    const target = await tempRoot("zeros-fork-target-");
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    upsertChat({
      id: "source-chat",
      folder: path.join(source, "packages", "app"),
      agentId: "codex",
      agentName: "Codex",
      model: "gpt-test",
      effort: "high",
      permissionMode: "default",
      lastModeId: "full-auto",
      prePlanModeId: null,
      fast: false,
      additionalDirectories: ["/private/host-secret"],
      title: "Copied chat",
      createdAt: 100,
      updatedAt: 200,
      sessionId: "native-session",
      providerBinding: {
        version: 1,
        kind: "native",
        providerId: "codex",
        resumeId: "native-session",
      },
      providerMetadata: null,
      pinned: true,
      archived: false,
      sourceChatId: null,
      kind: "code",
    });
    upsertChatMessage("source-chat", {
      msgId: "turn-1",
      kind: "text",
      payload: JSON.stringify({ role: "user", text: "copy me" }),
      createdAt: 110,
    });
    reinsertTurns([
      {
        chat_id: "source-chat",
        turn_id: "turn-1",
        workspace_id: "ws_source",
        folder: source,
        agent_id: "codex",
        ord: 1,
        summary: null,
        started_at: 110,
        ended_at: null,
        stop_reason: null,
        status: "running",
        pre_snapshot: "a".repeat(40),
        post_snapshot: "b".repeat(40),
        files: "[]",
        usage: null,
        rev: 0,
      },
    ]);

    const cloudWorkspaceId = "11111111-1111-4111-8111-111111111111";
    const exported = exportCloudWorkspaceForkRecords({
      sourceRoot: source,
      targetWorkspaceCanonicalId: cloudWorkspaceId,
      occurredAt: "2026-08-30T12:00:00.000Z",
    });
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("native-session");
    expect(serialized).not.toContain("/private/host-secret");
    expect(serialized).not.toContain("\"pre_snapshot\":\"aaaa");
    expect(exported.find((record) => record.entityKind === "turn")?.document).toMatchObject({
      row: {
        status: "cancelled",
        stop_reason: "workspace_forked",
        pre_snapshot: null,
        post_snapshot: null,
      },
    });

    closeZerosDb();
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    const localWorkspaceId = "22222222-2222-4222-8222-222222222222";
    const events: CloudWorkspaceForkRecordEvent[] = exported.map((record, index) => ({
      ...record,
      revision: index + 1,
    }));
    const result = importCloudWorkspaceForkRecords({
      targetRoot: target,
      targetWorkspaceId: "ws_target",
      targetWorkspaceCanonicalId: localWorkspaceId,
      events,
    });
    expect(result).toEqual({ chats: 1, messages: 1, turns: 1 });
    const cloudChatId = forkedChatId(cloudWorkspaceId, "source-chat");
    const localChatId = forkedChatId(localWorkspaceId, cloudChatId);
    expect(getChat(localChatId)).toMatchObject({
      folder: path.join(target, "packages", "app"),
      sourceChatId: cloudChatId,
      sessionId: null,
      providerBinding: null,
      additionalDirectories: [],
    });
    expect(windowChatMessages(localChatId, 10)).toHaveLength(1);
    expect(getTurn(localChatId, "turn-1")).toMatchObject({
      workspaceId: "ws_target",
      folder: target,
      status: "cancelled",
      preSnapshot: null,
      postSnapshot: null,
    });
  });

  it("ignores execution-only records and rejects an inconsistent transcript graph", async () => {
    const target = await tempRoot("zeros-fork-invalid-");
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    const base = {
      occurredAt: "2026-08-30T12:00:00.000Z",
      schemaVersion: 1,
    } as const;
    expect(() =>
      importCloudWorkspaceForkRecords({
        targetRoot: target,
        targetWorkspaceId: "ws_target",
        targetWorkspaceCanonicalId: "33333333-3333-4333-8333-333333333333",
        events: [
          {
            ...base,
            revision: 1,
            entityKind: "agent_session",
            entityId: "provider-session",
            operation: "upsert",
            document: { resumeId: "must-not-import" },
          },
          {
            ...base,
            revision: 2,
            entityKind: "message",
            entityId: "m:bad",
            operation: "upsert",
            document: {
              version: 1,
              chatId: "missing-chat",
              msgId: "message",
              ord: 1,
              kind: "text",
              payload: "{}",
              createdAt: 1,
            },
          },
        ],
      }),
    ).toThrow("Fork message document is invalid");
    expect(getChat("provider-session")).toBeNull();
  });

  it.each([
    ["an array", ["running"]],
    ["a number", 1],
  ])("rejects %s used as an imported turn status", async (_label, status) => {
    const target = await tempRoot("zeros-fork-status-");
    setZerosDbPathForTesting(":memory:");
    openZerosDb();

    expect(() =>
      importCloudWorkspaceForkRecords({
        targetRoot: target,
        targetWorkspaceId: "ws_target",
        targetWorkspaceCanonicalId: "33333333-3333-4333-8333-333333333333",
        events: forkEventsWithTurnStatus(status),
      }),
    ).toThrow("Fork turn document is invalid");
    expect(
      getChat(
        forkedChatId("33333333-3333-4333-8333-333333333333", "source-chat"),
      ),
    ).toBeNull();
  });

  it("cancels a scalar running turn imported from a fork record", async () => {
    const target = await tempRoot("zeros-fork-running-");
    setZerosDbPathForTesting(":memory:");
    openZerosDb();
    const targetWorkspaceCanonicalId = "33333333-3333-4333-8333-333333333333";

    importCloudWorkspaceForkRecords({
      targetRoot: target,
      targetWorkspaceId: "ws_target",
      targetWorkspaceCanonicalId,
      events: forkEventsWithTurnStatus("running"),
    });

    expect(
      getTurn(
        forkedChatId(targetWorkspaceCanonicalId, "source-chat"),
        "turn-1",
      ),
    ).toMatchObject({
      status: "cancelled",
      stopReason: "workspace_forked",
    });
  });
});
