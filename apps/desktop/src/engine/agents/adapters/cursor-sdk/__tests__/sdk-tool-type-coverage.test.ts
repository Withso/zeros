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

function toolTypesFromDeclaration(text: string): string[] {
  const source = ts.createSourceFile("tool-call-types.d.ts", text, ts.ScriptTarget.Latest, true);
  // ToolCall is inferred from this discriminated union. Read only the top
  // discriminator of each option, never nested action/result discriminators.
  const declarations = source.statements.filter(ts.isVariableStatement)
    .flatMap(statement => statement.declarationList.declarations)
    .map(declaration => [declaration.name.getText(source), declaration.type] as const);
  const types = new Map(declarations);
  const type = types.get("ToolCallSchema");
  if (!type || !ts.isTypeReferenceNode(type)) throw new Error("Missing Cursor ToolCallSchema type");
  const options = type.typeArguments?.[1];
  if (!options || !ts.isTupleTypeNode(options)) throw new Error("Cursor ToolCallSchema is no longer a discriminated union");
  return options.elements.map(option => {
    // SDK 1.1 names the union members with `typeof ShellToolCallSchema`,
    // while earlier pins inline each ZodObject. Resolve only local values;
    // missing, cyclic or unfamiliar declarations must still fail the gate.
    let resolved: ts.TypeNode | undefined = option;
    const seen = new Set<string>();
    while (resolved && ts.isTypeQueryNode(resolved)) {
      const name = resolved.exprName.getText(source);
      if (seen.has(name)) throw new Error(`Cyclic Cursor tool schema: ${name}`);
      seen.add(name);
      resolved = types.get(name);
    }
    const shape = resolved && ts.isTypeReferenceNode(resolved) ? resolved.typeArguments?.[0] : undefined;
    if (!shape || !ts.isTypeLiteralNode(shape)) throw new Error("Unknown Cursor tool option shape");
    const discriminator = shape.members.find(member => member.name?.getText(source) === "type");
    const literal = discriminator && ts.isPropertySignature(discriminator) && discriminator.type && ts.isTypeReferenceNode(discriminator.type)
      ? discriminator.type.typeArguments?.[0] : undefined;
    if (!literal || !ts.isLiteralTypeNode(literal) || !ts.isStringLiteral(literal.literal))
      throw new Error("Unknown Cursor tool discriminator");
    return literal.literal.text;
  });
}

describe("Cursor tool declaration reader", () => {
  const shell = 'z.ZodObject<{ type: z.ZodLiteral<"shell">; args: z.ZodObject<{ type: z.ZodLiteral<"nested"> }> }>';
  const union = (options: string) => `export declare const ToolCallSchema: z.ZodDiscriminatedUnion<"type", [${options}]>;`;

  it("reads inline shapes without collecting nested discriminators", () => {
    expect(toolTypesFromDeclaration(union(shell))).toEqual(["shell"]);
  });

  it("resolves referenced shapes and retains new tool names for the inventory check", () => {
    expect(toolTypesFromDeclaration(`
      ${union('typeof ShellToolCallSchema, typeof FutureToolCallSchema')}
      declare const ShellToolCallSchema: ${shell};
      declare const FutureToolCallSchema: z.ZodObject<{ type: z.ZodLiteral<"futureTool"> }>;
    `)).toEqual(["shell", "futureTool"]);
  });

  it.each([
    union("typeof MissingSchema"),
    `${union("typeof CyclicSchema")} declare const CyclicSchema: typeof CyclicSchema;`,
    union('z.ZodObject<{ args: z.ZodObject<{ type: z.ZodLiteral<"nested"> }> }>'),
    union("z.ZodObject<{ type: z.ZodString }>"),
  ])("fails closed on an unresolved shape or discriminator: %s", text => {
    expect(() => toolTypesFromDeclaration(text)).toThrow();
  });
});

describe("installed Cursor SDK tool inventory", () => {
  it("classifies every member of the installed ToolCall type union", () => {
    const require = createRequire(import.meta.url);
    const declarations = join(dirname(require.resolve("@cursor/sdk")), "vendor/cursor-sdk-shared/tool-call-types.d.ts");
    const installed = toolTypesFromDeclaration(readFileSync(declarations, "utf8"));
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
