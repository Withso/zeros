import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the actual handlers with a failing transport, without mounting the
// provider/session tree. The save result and its Send now caller are one contract.
const source = readFileSync(
  new URL("../agent-chat.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "agent-chat.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const handlers = new Map<string, string>();
function visit(node: ts.Node): void {
  if (
    ts.isVariableDeclaration(node) &&
    ["saveQueuedEdit", "sendNowQueued"].includes(node.name.getText(ast))
  ) {
    handlers.set(node.name.getText(ast), `const ${node.getText(ast)};`);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const code = ts.transpileModule([...handlers.values()].join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const draft = {
    displayText: "edited instructions",
    attachments: [{ delivery: "reference" }],
    segments: [],
  };
  const environment = {
    editingQueuedRef: { current: "queued-1" as string | null },
    queueSelectedRef: { current: "queued-1" },
    queueSaveInFlightRef: { current: false },
    serializeComposerState: () => draft,
    browserPickerSelection: null,
    expandMentionsInText: (text: string) => text,
    encodeComposerAttachments: vi
      .fn()
      .mockResolvedValue({
        blocks: [],
        bubbleAttachments: [],
        bubbleAttachmentById: new Map(),
        skipped: [],
      }),
    reportSkippedAttachments: vi.fn(),
    toMessageSegments: () => [],
    exitQueuedEdit: vi.fn(),
    session: {
      editQueued: vi.fn(),
      steerQueued: vi.fn().mockResolvedValue(true),
    },
    setQueueSelectedId: vi.fn(),
    toast: { error: vi.fn(), warning: vi.fn() },
  };
  const bind = new Function(
    "environment",
    `const { ${Object.keys(environment).join(", ")} } = environment;\n${code}\nreturn { saveQueuedEdit, sendNowQueued };`,
  );
  const actions = bind(environment) as {
    saveQueuedEdit: () => Promise<boolean>;
    sendNowQueued: (id: string) => Promise<void>;
  };
  return { ...environment, ...actions, draft };
}

describe("saving a queued edit before Send now", () => {
  it("keeps the draft and does not dispatch stale instructions after an upload failure", async () => {
    const f = fixture();
    f.encodeComposerAttachments.mockRejectedValue(new Error("disk full"));
    await f.sendNowQueued("queued-1");
    expect(f.toast.error).toHaveBeenCalledWith("Queued message wasn't saved", {
      description: "disk full",
    });
    expect(f.session.editQueued).not.toHaveBeenCalled();
    expect(f.session.steerQueued).not.toHaveBeenCalled();
    expect(f.exitQueuedEdit).not.toHaveBeenCalled();
    expect(f.setQueueSelectedId).not.toHaveBeenCalled();
    expect(f.queueSaveInFlightRef.current).toBe(false);
  });

  it("does not dispatch while another save owns the edited entry", async () => {
    const f = fixture();
    f.queueSaveInFlightRef.current = true;
    await f.sendNowQueued("queued-1");
    expect(f.session.steerQueued).not.toHaveBeenCalled();
  });

  it("does not dispatch the original entry when the edited draft is empty", async () => {
    const f = fixture();
    f.draft.displayText = "";
    f.draft.attachments = [];
    await f.sendNowQueued("queued-1");
    expect(f.session.steerQueued).not.toHaveBeenCalled();
  });

  it("saves the edited instructions before dispatching and restores the composer", async () => {
    const f = fixture();
    await f.sendNowQueued("queued-1");
    expect(f.session.editQueued).toHaveBeenCalledWith(
      "queued-1",
      expect.objectContaining({ text: "edited instructions" }),
    );
    expect(f.session.editQueued.mock.invocationCallOrder[0]).toBeLessThan(
      f.session.steerQueued.mock.invocationCallOrder[0],
    );
    expect(f.exitQueuedEdit).toHaveBeenCalledOnce();
    expect(f.session.steerQueued).toHaveBeenCalledWith("queued-1");
  });
});
