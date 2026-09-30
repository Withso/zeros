import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ execution: null as any }));
vi.mock("../cloud-provider-execution", async importOriginal => ({
  ...await importOriginal<any>(), cloudProviderExecution: () => state.execution,
}));
import { CloudCustomizationRedactor } from "../cloud-customization-redaction";
import { AgentGateway } from "../gateway";
import { CodexAppServerTranslator } from "../adapters/codex/app-server-translator";
import { redactLogSecrets } from "@zeros/protocol/scrub";
import { acquireCloudNativeHistory } from "../containment/cloud-native-history";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";

describe("cloud customization publication regressions", () => {
  it("preserves execution and tool identities with a common DEBUG=1 MCP environment", () => {
    const redactor = new CloudCustomizationRedactor(["1"]);
    const notification = { sessionId: "11111111-2222-4333-8444-555555555555", update: {
      sessionUpdate: "tool_call_update" as const, toolCallId: "tool-1", status: "completed" as const,
      rawOutput: "DEBUG=1",
    } };
    const scrubbed = redactor.notification(notification);
    expect(scrubbed.sessionId).toBe(notification.sessionId);
    expect((scrubbed.update as any).toolCallId).toBe("tool-1");
  });

  it("does not publish a nearly complete secret in a native Codex tool output snapshot", () => {
    const literal = "v7-synthetic-opaque-private-value";
    const prefix = literal.slice(0, -1);
    const redactor = new CloudCustomizationRedactor([literal]);
    const published: unknown[] = [];
    const translator = new CodexAppServerTranslator({ sessionId: "execution", emit: event => published.push(redactor.notification(event)) });
    translator.handle("item/started", { threadId: "thread", turnId: "turn", item: {
      type: "commandExecution", id: "call", command: "printenv", cwd: "/srv/zeros/workspace", status: "inProgress", commandActions: [],
    } });
    translator.handle("item/commandExecution/outputDelta", { threadId: "thread", turnId: "turn", itemId: "call", delta: prefix });
    translator.handle("item/commandExecution/outputDelta", { threadId: "thread", turnId: "turn", itemId: "call", delta: literal.slice(-1) });
    expect(JSON.stringify(published)).not.toContain(prefix);
  });

  it("scrubs literal secrets from rejected cloud provider prompts before the engine error path", async () => {
    const literal = "v7-synthetic-opaque-private-value";
    const events = { onSessionUpdate: vi.fn(), onPermissionRequest: vi.fn(), onQuestionRequest: vi.fn(), onAgentStderr: vi.fn(), onAgentExit: vi.fn() };
    const gateway = new AgentGateway({ projectRoot: "/tmp", events, cloudAgentExecutionFactory: { prepare: vi.fn() } });
    const internals = gateway as any;
    state.execution = { lease: { signal: new AbortController().signal, admission: { provider: "codex" }, validate: vi.fn(async () => {}) }, redactor: new CloudCustomizationRedactor([literal]) };
    internals.executionBoundaries.set("execution", {});
    internals.adapterForSession = () => ({ agentId: "codex", prompt: vi.fn(async () => { throw new Error(`MCP failed: ${literal}`); }) });
    try {
      const caught = await gateway.prompt("codex", "execution", [{ type: "text", text: "Hi" }]).catch(error => error);
      expect(caught).toBeInstanceOf(Error);
      // This is the generic scrubber used by zeros-engine's persisted error_notice.
      expect(redactLogSecrets(caught.message)).not.toContain(literal);
    } finally { state.execution = null; internals.executionBoundaries.clear(); }
  });

  it.runIf(process.platform === 'linux')('does not expose an old member secret through a newly admitted native history', async () => {
    const root = await mkdtemp('/tmp/v7-native-history-');
    const literal = 'v7-synthetic-old-member-secret';
    const authority = {owner:'a'.repeat(64),currentKeyVersion:1,keys:{'1':randomBytes(32).toString('base64url')}};
    const input = {root, conversationId:'shared-conversation',provider:'codex' as const,uid:process.getuid!(),gid:process.getgid!(),customization:{authority,secrets:[literal]}};
    let held: Awaited<ReturnType<typeof acquireCloudNativeHistory>> | undefined;
    try {
      held = await acquireCloudNativeHistory(input);
      // Model the provider's private native transcript, before gateway publication.
      await writeFile(`${held.mount.directory}/rollout.jsonl`, JSON.stringify({toolOutput:literal})+'\n');
      expect(new CloudCustomizationRedactor([literal]).value(literal)).toBe('[redacted]');
      await held.release(); held = undefined;
      // A fresh execution has no current MCP value, but its encrypted native
      // history retains the old literal's redaction authority after restart.
      held = await acquireCloudNativeHistory({...input,customization:{authority,secrets:[]}});
      const historical = JSON.parse(await readFile(`${held.mount.directory}/rollout.jsonl`,'utf8')).toolOutput;
      const nextExecution = held.redactor!;
      expect(nextExecution.value(historical)).not.toContain(literal);
    } finally { await held?.release(); await rm(root,{recursive:true,force:true}); }
  });
});
