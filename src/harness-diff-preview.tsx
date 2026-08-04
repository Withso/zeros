// Standalone development harness — NOT part of the shipped app.
//
// Exercises the real EditCard and turn-footer pill hover trees in a browser so
// Radix pointer/focus timing, portal placement, and @pierre/diffs mounting stay
// covered by test:ui-smoke without booting the Electron shell.

import "../styles/zeros-tokens.css";
import "../styles/semantic-tokens.css";
import "../styles/globals.css";

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("./zeros/ui/primitives/tooltip");
  const { EditCard } = await import("./zeros/agent/renderers/tool-edit");
  const { EventRow } = await import("./zeros/agent/renderers/event-row");
  const { TurnFilePill } = await import("./zeros/agent/turn-footer");
  const { CodeEditor } = await import("./shell/column3-tabs/code-editor/index");
  const { MarkdownPreview } = await import("./shell/column3-tabs/file-viewer");
  const { primeWorkspaceFileDiff } =
    await import("./shell/workspace-file-data-cache");

  const oldLine = `const value = "${"old-city ".repeat(90)}";`;
  const newLine = `const value = "${"new-city ".repeat(90)}";`;
  const patch =
    "diff --git a/src/shared.ts b/src/shared.ts\n" +
    "--- a/src/shared.ts\n" +
    "+++ b/src/shared.ts\n" +
    "@@ -8,3 +8,3 @@\n" +
    " const before = true;\n" +
    `-${oldLine}\n` +
    `+${newLine}\n` +
    " export { value };\n";
  const footerPath = "src/footer-preview.ts";
  primeWorkspaceFileDiff(
    {
      workspaceId: "workspace-smoke",
      path: footerPath,
      diffScope: "turn",
      turnChatId: "chat-smoke",
      turnId: "turn-smoke",
    },
    patch.replaceAll("src/shared.ts", footerPath),
  );

  const ctx = { editBaselines: new Map() } as never;
  const edit = {
    id: "edit-smoke",
    kind: "tool",
    toolCallId: "edit-smoke",
    title: "Edit",
    toolKind: "edit",
    status: "completed",
    rawInput: {
      file_path: "src/shared.ts",
      old_string: oldLine,
      new_string: newLine,
    },
    createdAt: 0,
    updatedAt: 0,
  } as never;
  const placementEdit = {
    id: "placement-edit-smoke",
    kind: "tool",
    toolCallId: "placement-edit-smoke",
    title: "Edit",
    toolKind: "edit",
    status: "completed",
    rawInput: {
      file_path: "src/placement.ts",
      old_string: "const placement = 'old';",
      new_string: "const placement = 'new';",
    },
    createdAt: 0,
    updatedAt: 0,
  } as never;
  const read = {
    id: "read-smoke",
    kind: "tool",
    toolCallId: "read-smoke",
    title: "Read",
    toolKind: "read",
    status: "completed",
    rawInput: { file_path: "src/shared.ts" },
    createdAt: 0,
    updatedAt: 0,
  } as never;

  function Harness() {
    return (
      <TooltipProvider delayDuration={500} skipDelayDuration={0}>
        <header
          data-testid="protected-top-chrome"
          className="bg-bg2 h-[84px] shrink-0"
        />
        <main
          data-agent-diff-collision-boundary=""
          className="bg-bg1 text-fg1 relative flex min-h-[616px] flex-col gap-8 p-10"
        >
          {/* This short diff fits above the trigger inside the browser window,
              but not above it inside the transcript viewport. The real shell's
              40px global bar + 44px pane tabs create the same boundary. */}
          <div
            data-testid="placement-edit-host"
            className="absolute top-[55px] left-[360px]"
          >
            <EditCard message={placementEdit} ctx={ctx} />
          </div>
          <button type="button" data-testid="parking-lot" className="w-fit">
            Move pointer here
          </button>
          <div data-testid="edit-host">
            <EditCard message={edit} ctx={ctx} />
          </div>
          <div data-testid="read-host">
            <EventRow
              message={read}
              ctx={ctx}
              detail={<pre>const value = &apos;new&apos;;</pre>}
            />
          </div>
          <div data-testid="footer-host" className="flex">
            <TurnFilePill
              file={{
                path: footerPath,
                status: "modified",
                additions: 1,
                deletions: 1,
              }}
              chatId="chat-smoke"
              turnId="turn-smoke"
              workspaceId="workspace-smoke"
              onOpen={(path) => console.log("[harness] open turn diff", path)}
            />
          </div>
          <div
            data-testid="file-editor-host"
            className="h-[180px] w-[450px] overflow-hidden"
          >
            <CodeEditor value={newLine} filePath="src/shared.ts" />
          </div>
          <div
            data-testid="markdown-preview-host"
            className="h-[180px] w-[450px] overflow-x-hidden overflow-y-auto"
          >
            <MarkdownPreview
              html={`<p>${"unbroken-preview-token".repeat(80)}</p><pre><code>${newLine}</code></pre>`}
            />
          </div>
        </main>
      </TooltipProvider>
    );
  }

  createRoot(document.getElementById("root")!).render(<Harness />);
}

void main();
