import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CodeReviewAgentTools } from "../code-review-tools";
import { codeReviewAgentActor } from "../../code-review/actors";
import { CodeReviewStore } from "../../db/code-review";
import { runMigrations } from "../../db/migrations";
import { DesignCodeToolAdmissions } from "../../design/code-tool-admission";
import type { CodeReviewThread, CodeReviewListResult } from "@zeros/protocol/code-review";
import type { AgentSessionTools } from "../session-tools";

const input = { anchor: { path: "example.ts", side: "file" as const, startLine: 1, endLine: 2, revision: "sha256:original" }, body: "Please review", requestId: "create-one" };
const human = { id: "human:reviewer", name: "Reviewer", kind: "human" as const };
describe("scoped agent workspace review tools", () => {
  let root: string;
  let db: Database.Database;
  let store: CodeReviewStore;
  let live: boolean;
  let client: Client | undefined;
  let admitted: AgentSessionTools | null;
  const changed = vi.fn();
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-agent-review-"));
    writeFileSync(path.join(root, "example.ts"), "original\nsecond\n");
    db = new Database(":memory:"); runMigrations(db); store = new CodeReviewStore(() => db);
    live = true; client = undefined; admitted = null; changed.mockClear();
  });
  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await admitted?.dispose();
    db.close(); rmSync(root, { recursive: true, force: true });
  });
  function tools(provider = "codex") {
    return new CodeReviewAgentTools({
      workspaceId: "A", workspacePath: root,
      assertCurrent: () => { if (!live) throw new Error("Workspace grant retired"); },
    }, {
      resolveReadCwd: (id) => { if (id !== "A") throw new Error("Wrong workspace"); return root; },
      ownerRoots: () => [root],
    }, codeReviewAgentActor({ agentId: provider, conversationId: "durable-conversation", executionId: "execution-one" })!, changed, store);
  }
  const value = <T>(result: Awaited<ReturnType<CodeReviewAgentTools["callTool"]>>): T => {
    const first = result.content[0];
    if (first?.type !== "text") throw new Error("Expected review result");
    return JSON.parse(first.text) as T;
  };

  it.each(["claude", "codex", "cursor"])("derives immutable %s attribution from the admitted provider and durable conversation", async (provider) => {
    const handler = tools(provider);
    const thread = value<CodeReviewThread>(await handler.callTool("code_review_create", input, new AbortController().signal));
    expect(thread.workspaceId).toBe("A");
    expect(thread.comments[0]!.author).toMatchObject({ id: `agent:${provider}:durable-conversation`, provider, kind: "agent" });
    expect(codeReviewAgentActor({ agentId: provider, executionId: "execution-two", conversationId: "durable-conversation" })).toEqual(thread.comments[0]!.author);
    expect(codeReviewAgentActor({ agentId: "unknown", executionId: "execution" })).toBeNull();
    expect(readFileSync(path.join(root, "example.ts"), "utf8")).toBe("original\nsecond\n");
  });

  it("reads human replies, appends without replacing them, and rejects stale state decisions", async () => {
    const handler = tools();
    const signal = new AbortController().signal;
    const thread = value<CodeReviewThread>(await handler.callTool("code_review_create", input, signal));
    store.reply({ workspaceId: "A", threadId: thread.id, body: "Human reply" }, human);
    const reply = value<CodeReviewThread>(await handler.callTool("code_review_reply", { threadId: thread.id, body: "Agent follow-up", requestId: "reply-one" }, signal));
    expect(reply.comments.map((comment) => comment.body)).toEqual([input.body, "Human reply", "Agent follow-up"]);
    await expect(handler.callTool("code_review_set_resolved", { threadId: thread.id, resolved: true, expectedVersion: thread.version }, signal)).rejects.toMatchObject({ code: "CODE_REVIEW_STALE" });
    const resolved = value<CodeReviewThread>(await handler.callTool("code_review_set_resolved", { threadId: thread.id, resolved: true, expectedVersion: reply.version }, signal));
    const reopened = value<CodeReviewThread>(await handler.callTool("code_review_set_resolved", { threadId: thread.id, resolved: false, expectedVersion: resolved.version }, signal));
    const listed = value<CodeReviewListResult>(await handler.callTool("code_review_list", {}, signal));
    expect(listed.threads).toEqual([reopened]);
    expect(changed).toHaveBeenCalledWith("A");
  });

  it("rejects workspace/author overrides and revoked or cancelled grants before persisting", async () => {
    const handler = tools();
    const signal = new AbortController().signal;
    for (const forged of [{ workspaceId: "B" }, { author: human }, { actor: human }, { cwd: root }, { provider: "claude" }]) {
      await expect(handler.callTool("code_review_create", { ...input, ...forged }, signal)).rejects.toMatchObject({ code: "CODE_REVIEW_INVALID" });
    }
    const thread = store.create({ workspaceId: "B", ...input }, human);
    await expect(handler.callTool("code_review_reply", { threadId: thread.id, body: "Cross-workspace reply" }, signal)).rejects.toMatchObject({ code: "CODE_REVIEW_NOT_FOUND" });
    live = false;
    expect(() => handler.listTools()).toThrow(/retired/);
    await expect(handler.callTool("code_review_create", input, signal)).rejects.toThrow(/retired/);
    live = true;
    const controller = new AbortController(); controller.abort();
    await expect(handler.callTool("code_review_create", input, controller.signal)).rejects.toThrow();
    expect(store.list({ workspaceId: "A" }).threads).toEqual([]);
  });

  it("exposes real review operations through the existing authenticated product MCP admission without a Design directory", async () => {
    const controller = new AbortController();
    const admissions = new DesignCodeToolAdmissions({
      resolveTarget: async () => null,
      resolveWorkspace: () => null,
      workspaceTools: (admission) => {
        expect(admission.agentId).toBe("cursor");
        return tools(admission.agentId);
      },
    });
    admitted = await admissions.admit({ agentId: "cursor", executionId: "execution", conversationId: "durable-conversation", cwd: root, signal: controller.signal });
    expect(admitted?.mcpServers).toHaveLength(1);
    const registration = admitted!.mcpServers[0]!;
    if (registration.transport !== "http") throw new Error("Expected scoped MCP transport");
    const envName = registration.headersFromEnv?.Authorization;
    if (!envName) throw new Error("Expected scoped authentication");
    client = new Client({ name: "review-tool-fixture", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(registration.url), {
      requestInit: { headers: { Authorization: admitted!.env[envName]! } },
    }));
    const catalog = await client.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "code_review_list", "code_review_create", "code_review_reply", "code_review_set_resolved",
    ]));
    const created = await client.callTool({ name: "code_review_create", arguments: input });
    const thread = value<CodeReviewThread>(created as Awaited<ReturnType<CodeReviewAgentTools["callTool"]>>);
    expect(thread.comments[0]!.author).toMatchObject({ kind: "agent", provider: "cursor" });
    const read = await client.callTool({ name: "code_review_list", arguments: {} });
    expect(value<CodeReviewListResult>(read as Awaited<ReturnType<CodeReviewAgentTools["callTool"]>>).threads).toEqual([thread]);
    admitted!.revoke();
    await expect(client.callTool({ name: "code_review_create", arguments: { ...input, requestId: "late" } })).rejects.toThrow();
    expect(store.list({ workspaceId: "A" }).threads).toHaveLength(1);
    expect(readFileSync(path.join(root, "example.ts"), "utf8")).toBe("original\nsecond\n");
  });
});
