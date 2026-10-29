import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { InteractionUpdateSchema, type InteractionUpdate, type SDKMessage } from "@cursor/sdk";
import ts from "typescript";
import { expect, it } from "vitest";
import { CursorSdkTranslator } from "../translator";
import type { SessionNotification } from "../../../types";

const messages = {
  system: "sdk-owned", user: "sdk-owned", assistant: "handled", tool_call: "handled", thinking: "handled",
  status: "handled", request: "sdk-owned", task: "sdk-owned", summary: "handled", usage: "handled",
} satisfies Record<SDKMessage["type"], "handled" | "sdk-owned">;
const deltas = {
  "text-delta": "handled", "thinking-delta": "handled", "thinking-completed": "handled",
  "tool-call-started": "handled", "tool-call-completed": "handled", "partial-tool-call": "handled", "tool-call-delta": "handled",
  "summary-started": "handled", "summary-completed": "handled", summary: "private",
  "turn-ended": "handled", "user-message-appended": "sdk-owned", "token-delta": "sdk-owned",
  "step-started": "sdk-owned", "step-completed": "sdk-owned", "tool-requests-listed": "sdk-owned", "shell-output-delta": "sdk-owned",
} satisfies Record<InteractionUpdate["type"], "handled" | "sdk-owned" | "private">;

it("classifies every installed SDK message and interaction delta", () => {
  const require = createRequire(import.meta.url);
  const text = readFileSync(join(dirname(require.resolve("@cursor/sdk")), "messages.d.ts"), "utf8");
  const source = ts.createSourceFile("messages.d.ts", text, ts.ScriptTarget.Latest, true);
  const union = source.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "SDKMessage")!;
  expect(ts.isUnionTypeNode(union.type)).toBe(true);
  const names = (union.type as ts.UnionTypeNode).types.map(type => type.getText(source));
  const installed = source.statements.filter(ts.isInterfaceDeclaration).filter(node => names.includes(node.name.text)).map(node => {
    const type = node.members.find(member => member.name?.getText(source) === "type") as ts.PropertySignature;
    return (type.type as ts.LiteralTypeNode).literal.getText(source).replaceAll('"', "");
  });
  expect(Object.keys(messages).sort()).toEqual(installed.sort());
  expect(Object.keys(deltas).sort()).toEqual(InteractionUpdateSchema.options.map(option => option.shape.type.value).sort());
});

it.each([false, true])("accepts the real pinned summary schema with failed=%s", failed => {
  const events: SessionNotification[] = [];
  const translator = new CursorSdkTranslator({ sessionId: "native-schema", emit: event => events.push(event) });
  translator.feedDelta(InteractionUpdateSchema.parse({ type: "summary-started" }));
  translator.feedDelta(InteractionUpdateSchema.parse({ type: "summary-completed", failed, fallback: !failed }));
  expect(events[0].update).toMatchObject({ kind: "compaction", status: "in_progress" });
  expect(events.at(-1)!.update).toMatchObject({ status: failed ? "failed" : "completed" });
});
