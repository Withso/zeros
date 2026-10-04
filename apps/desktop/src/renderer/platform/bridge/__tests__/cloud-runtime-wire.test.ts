import { describe, expect, it } from "vitest";
import { cloudWorkspaceKey, cloudScopedId } from "../cloud-workspace-key";
import {
  cloudIncoming,
  cloudOutgoing,
  cloudRequestTarget,
  type CloudRuntimeScope,
} from "../cloud-runtime-wire";
import { runSessionId } from "@zeros/protocol/run-actions";

const scope: CloudRuntimeScope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  root: "/workspace/repo",
  engineWorkspaceId: "local-main",
};
const key = cloudWorkspaceKey(scope);

describe("cloud runtime wire routing", () => {
  it.each([
    "identity", "list", "create", "pause", "resume", "remove", "divergences", "sync", "relocate",
  ])("keeps cloudReplica.%s on this Mac even with a cloud workspace parameter", (operation) => {
    expect(cloudRequestTarget({
      type: "WORKSPACE_REQUEST",
      op: `cloudReplica.${operation}`,
      params: { workspaceId: key, cwd: key, replicaId: "local-replica" },
    })).toBeNull();
  });

  it("routes file operations by stable workspace identity and preserves relative file paths", () => {
    const message = {
      type: "WORKSPACE_REQUEST",
      op: "file.read",
      params: { workspaceId: key, path: "src/main.ts" },
    };
    expect(cloudRequestTarget(message)?.workspaceId).toBe(scope.workspaceId);
    expect(cloudOutgoing(scope, message).params).toEqual({
      workspaceId: "local-main",
      path: "src/main.ts",
    });
  });
  it("isolates live execution routing without rewriting provider identities or tool payloads", () => {
    const binding = {
      version: 1,
      providerId: "codex",
      resumeId: "provider-thread",
      legacySessionId: "native-id",
    };
    const update = {
      toolCallId: "same",
      content: "cloud://not/a/route",
      sessionId: "tool-owned",
    };
    const mapped = cloudIncoming(scope, {
      type: "AGENT_SESSION_UPDATE",
      sessionId: "run",
      executionId: "run",
      providerBinding: binding,
      update,
    });
    expect(mapped.sessionId).toBe(cloudScopedId(scope, "run"));
    expect(mapped.providerBinding).toBe(binding);
    expect(mapped.update).toBe(update);
    expect(
      cloudOutgoing(scope, { ...mapped, cwd: `${key}/src` }),
    ).toMatchObject({
      sessionId: "run",
      executionId: "run",
      cwd: "/workspace/repo/src",
      providerBinding: binding,
      update,
    });
  });
  it("keeps legacy chat resume handles opaque while scoping chat rows and tombstones", () => {
    const mapped = cloudIncoming(scope, {
      type: "WORKSPACE_RESPONSE",
      op: "chats.list",
      result: {
        chats: [
          { id: "chat", folder: scope.root, sessionId: "legacy-provider" },
        ],
        chatDeletions: ["deleted"],
      },
    });
    expect(mapped.result).toEqual({
      chats: [
        {
          id: cloudScopedId(scope, "chat"),
          folder: key,
          sessionId: "legacy-provider",
        },
      ],
      chatDeletions: [cloudScopedId(scope, "deleted")],
    });
  });
  it("rejects mixed workspace requests before dispatch", () => {
    const other = {
      ...scope,
      workspaceId: "33333333-3333-4333-8333-333333333333",
    };
    expect(() =>
      cloudRequestTarget({
        workspaceId: key,
        chatId: cloudScopedId(other, "chat"),
      }),
    ).toThrow(/cross cloud/);
    expect(() =>
      cloudOutgoing(scope, { cwd: cloudWorkspaceKey(other) }),
    ).toThrow(/changed/);
  });
  it("does not interpret arbitrary content as routing authority", () => {
    expect(
      cloudRequestTarget({ type: "AGENT_PROMPT", prompt: [{ text: key }] }),
    ).toBeNull();
    const payload = JSON.stringify({ sessionId: "native", text: key });
    expect(
      cloudIncoming(scope, {
        type: "WORKSPACE_RESPONSE",
        op: "messages.window",
        result: { messages: [{ payload }] },
      }).result,
    ).toEqual({ messages: [{ payload }] });
  });
  it("maps notification and run-terminal envelopes while preserving their content", () => {
    const update = { sessionUpdate: "tool_call", toolCallId: "native" };
    expect(
      cloudIncoming(scope, {
        type: "AGENT_SESSION_UPDATE",
        notification: { sessionId: "execution", update },
      }),
    ).toMatchObject({
      notification: { sessionId: cloudScopedId(scope, "execution"), update },
    });
    const nativeRun = `${runSessionId(scope.root)}-dev`;
    const uiRun = cloudScopedId(scope, `${runSessionId(key)}-dev`);
    expect(
      cloudIncoming(scope, {
        type: "PTY_DATA",
        sessionId: nativeRun,
        data: "same bytes",
      }),
    ).toMatchObject({ sessionId: uiRun, data: "same bytes" });
    expect(
      cloudOutgoing(scope, {
        type: "PTY_WRITE",
        sessionId: uiRun,
        data: "same bytes",
      }),
    ).toMatchObject({ sessionId: nativeRun, data: "same bytes" });
    expect(
      cloudIncoming(scope, {
        type: "WORKSPACE_RESPONSE",
        op: "workspace.get",
        result: {
          id: "local-main",
          path: scope.root,
          repoRoot: scope.root,
          branch: "work",
        },
      }),
    ).toMatchObject({
      result: {
        id: key,
        path: key,
        repoRoot: key,
        branch: "work",
        placement: "cloud",
      },
    });
  });
});

it("scopes cloud workspace-change arrays for the shared Git/files invalidation consumer", () => {
  for (const workspaceIds of [undefined, ["local-main"]]) {
    expect(cloudIncoming(scope, { type: "DB_CHANGED", kinds: ["workspaces"], workspaceIds }))
      .toMatchObject({ workspaceIds: [key], cloudWorkspace: key });
  }
});
it("rejects a foreign cloud owner embedded in a typed incoming turn row", () => {
  const other = { ...scope, workspaceId: "33333333-3333-4333-8333-333333333333" };
  for (const identity of [{ chatId: cloudScopedId(other, "chat") }, { workspaceId: cloudWorkspaceKey(other) }, { folder: cloudWorkspaceKey(other) }]) {
    expect(() => cloudIncoming(scope, { type: "WORKSPACE_RESPONSE", op: "turns.get", result: { turn: {
      chatId: "chat", turnId: "turn", workspaceId: scope.engineWorkspaceId, folder: scope.root, ...identity,
    } } })).toThrow(/changed/);
  }
});
