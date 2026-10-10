import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ToolType } from "@cursor/sdk";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { SessionNotification } from "../../../types";
import { CursorSdkTranslator } from "../translator";

type Kind = "execute" | "edit" | "delete" | "read" | "search" | "list" | "mcp" | "task" | "subagent" | "other";
// Each installed type needs a reviewed disposition. Keep the existing stream
// and child-checkpoint presentations; computerUse has no dedicated UI.
const coverage = {
  shell: ["handled", "execute", "execute"],
  write: ["handled", "edit", "edit"],
  delete: ["handled", "other", "delete"],
  glob: ["handled", "search", "search"],
  grep: ["handled", "search", "search"],
  read: ["handled", "read", "read"],
  edit: ["handled", "edit", "edit"],
  ls: ["handled", "other", "list"],
  readLints: ["handled", "read", "other"],
  mcp: ["handled", "mcp", "mcp"],
  generateImage: ["generic", "other", "other"],
  recordScreen: ["generic", "other", "other"],
  computerUse: ["generic", "other", "other"],
  semSearch: ["handled", "search", "search"],
  createPlan: ["generic", "other", "other"],
  updateTodos: ["generic", "other", "other"],
  task: ["handled", "task", "subagent"],
} as const satisfies Record<ToolType, readonly ["handled" | "generic", Kind, Kind]>;

describe("installed Cursor SDK tool inventory", () => {
  it("classifies every member of the installed ToolCall type union", () => {
    const require = createRequire(import.meta.url);
    const declarations = join(dirname(require.resolve("@cursor/sdk")), "vendor/cursor-sdk-shared/tool-call-types.d.ts");
    const source = ts.createSourceFile(declarations, readFileSync(declarations, "utf8"), ts.ScriptTarget.Latest, true);
    // ToolCall is inferred from this discriminated union. Read only the top
    // discriminator of each option, never nested action/result discriminators.
    const declaration = source.statements.filter(ts.isVariableStatement)
      .flatMap(statement => statement.declarationList.declarations)
      .find(candidate => candidate.name.getText(source) === "ToolCallSchema");
    const type = declaration?.type;
    if (!type || !ts.isTypeReferenceNode(type)) throw new Error("Missing Cursor ToolCallSchema type");
    const options = type.typeArguments?.[1];
    if (!options || !ts.isTupleTypeNode(options)) throw new Error("Cursor ToolCallSchema is no longer a discriminated union");
    const installed = options.elements.map(option => {
      const shape = ts.isTypeReferenceNode(option) ? option.typeArguments?.[0] : undefined;
      if (!shape || !ts.isTypeLiteralNode(shape)) throw new Error("Unknown Cursor tool option shape");
      const discriminator = shape.members.find(member => member.name?.getText(source) === "type");
      const literal = discriminator && ts.isPropertySignature(discriminator) && discriminator.type && ts.isTypeReferenceNode(discriminator.type)
        ? discriminator.type.typeArguments?.[0] : undefined;
      if (!literal || !ts.isLiteralTypeNode(literal) || !ts.isStringLiteral(literal.literal))
        throw new Error("Unknown Cursor tool discriminator");
      return literal.literal.text;
    });
    expect(Object.keys(coverage).sort()).toEqual(installed.sort());
    expect(coverage.computerUse).toEqual(["generic", "other", "other"]);
  });

  it.each(Object.entries(coverage))("retains the reviewed stream and child presentation for %s", async (name, [, streamKind, childKind]) => {
    const updates: SessionNotification["update"][] = [];
    const translator = new CursorSdkTranslator({ sessionId: "fixture", emit: notification => updates.push(notification.update) });
    const args = { path: "file.ts", command: "printf fixture", pattern: "fixture", query: "fixture", description: "fixture", toolName: "fixture" };
    const result = { status: "success", value: {} };
    translator.feed({ type: "tool_call", call_id: "stream", name, status: "completed", args, result });
    expect(updates.find(update => update.sessionUpdate === "tool_call")).toMatchObject({ kind: streamKind });

    const childUpdates: SessionNotification["update"][] = [];
    const parent = new CursorSdkTranslator({ sessionId: "fixture", emit: notification => childUpdates.push(notification.update) });
    parent.feed({ type: "tool_call", call_id: "parent", name: "task", status: "completed", args: { description: "Inventory" },
      result: { status: "success", value: { agentId: "child", conversationSteps: [{ type: "toolCall", message: { type: name, args, result } }] } } });
    await parent.flushSubagents();
    expect(childUpdates.find(update => update.sessionUpdate === "tool_call" && update.parentToolId)).toMatchObject({ kind: childKind });
  });
});
