import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { messageToEditorContent } from "../composer-editor/reconstruct";
import { isPristineEditDraft } from "../edit-draft-content";

const source = readFileSync(
  new URL("../turn-container.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "turn-container.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let expression = "";
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "isPristine")
    expression = node.initializer!.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);

const original = () =>
  messageToEditorContent({
    text: "inspect ",
    attachments: ["first", "second"].map((id) => ({
      name: `${id}.pdf`,
      mimeType: "application/pdf",
      kind: "file" as const,
      attachmentId: id,
      delivery: "reference" as const,
    })),
  });

function pristine(
  initial: ReturnType<typeof original>,
  edited: ReturnType<typeof original>,
): boolean {
  const environment = {
    originalText: "inspect ",
    originalAttachmentCount: initial.attachments.length,
    text: "inspect ",
    attachments: edited.attachments,
    json: edited.json,
    liveRef: {
      current: {
        text: "inspect ",
        attachments: edited.attachments,
        json: edited.json,
      },
    },
    originalContentRef: { current: initial },
    isPristineEditDraft,
  };
  const code = ts.transpileModule(
    `const { ${Object.keys(environment).join(",")} } = environment; return (${expression});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  return new Function("environment", code)(environment);
}

describe("sent-message edit draft preservation", () => {
  it("retains an incomplete restored document without crashing persistence", () => {
    const initial = original();
    const edited = structuredClone(initial);
    edited.json = { type: "doc", content: [{ type: "attachment" }] };
    expect(pristine(initial, edited)).toBe(false);
  });
  it("retains an attachment replacement with unchanged text and count", () => {
    const initial = original();
    const edited = structuredClone(initial);
    edited.attachments[0]!.contextAttachmentId = "replacement";
    expect(pristine(initial, edited)).toBe(false);
  });
  it("retains reordered attachment chips with unchanged text and count", () => {
    const initial = original();
    const edited = structuredClone(initial);
    const nodes = (edited.json as any).content[0].content;
    [nodes[1], nodes[2]] = [nodes[2], nodes[1]];
    expect(pristine(initial, edited)).toBe(false);
  });
  it("retains a mention-only change with the same visible text", () => {
    const initial = original();
    const edited = structuredClone(initial);
    (edited.json as any).content[0].content[0] = {
      type: "mention",
      attrs: {
        token: "inspect ",
        path: "different/path",
        label: "inspect",
        kind: "file",
      },
    };
    expect(pristine(initial, edited)).toBe(false);
  });
  it("recognizes an unchanged message reconstructed with fresh editor node ids", () => {
    expect(pristine(original(), original())).toBe(true);
  });
});
