// Standalone development harness — NOT part of the shipped app.
//
// Exercises the real EditCard and turn-footer pill hover trees in a browser so
// Radix pointer/focus timing, portal placement, and @pierre/diffs mounting stay
// covered by test:ui-smoke without booting the Electron shell.

import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../shared/ui/primitives/tooltip");
  const { EditCard } = await import("../features/agent/renderers/tool-edit");
  const { EventRow } = await import("../features/agent/renderers/event-row");
  const { TurnFilePill } = await import("../features/agent/turn-footer");
  const { CodeEditor } = await import("../shell/workbench/tabs/code-editor");
  const { MarkdownPreview } =
    await import("../shell/workbench/tabs/file-viewer");
  const { primeWorkspaceFileDiff } =
    await import("../shell/workspace-file-data-cache");
  const { WorkspaceFileTree } =
    await import("../shell/workbench/tabs/workspace-file-tree");
  const { FilesSearchSidebar } =
    await import("../shell/workbench/tabs/files-search-sidebar");
  const { primeWorkspaceFiles } =
    await import("../shell/workspace-files-cache");
  const { flushSync } = await import("react-dom");
  const { prewarmSyntax, ensureThemeColors } =
    await import("../features/agent/renderers/syntax");
  const { resolveCodeTheme } = await import("../shared/theme/code-themes");
  const { getPrefs } = await import("../shared/theme/store");
  const { shikiLangForPath } =
    await import("../shell/workbench/tabs/code-editor/shiki-lang");

  const oldLine = `const value = "${"old-city ".repeat(90)}";`;
  const newLine = `const value = "${"new-city ".repeat(90)}";`;
  // Indented long line for the file-editor fixture: soft-wrapped continuation
  // rows must hang at the line's own indent (6 spaces here), not column 0.
  const indentedLine = `      const wrapped = "${"wrap-city ".repeat(40)}";`;
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

  // File-tree fixture: a real WorkspaceFileTree over a primed listing (no
  // native IPC in the browser). Every directory keeps ≥2 children so
  // flattenEmptyDirectories can't merge the depth levels the smoke checks
  // measure, and the pre-selected depth-3 file expands the whole chain.
  const treeCwd = "/workspace-smoke";
  primeWorkspaceFiles(treeCwd, [
    "artifacts/api-server/src/index.ts",
    "artifacts/api-server/src/util.ts",
    "artifacts/api-server/build.mjs",
    "artifacts/api-server/package.json",
    "artifacts/mockup-sandbox/index.html",
    "artifacts/mockup-sandbox/package.json",
    "lib/readme.md",
    "package.json",
  ]);

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

  // Files Search is a real sidebar mode: it fills the same resizable shell as
  // the tree, starts with only its input, and keeps its column open after a
  // result routes to the viewer.
  function SearchSidebarFixture() {
    const [open, setOpen] = React.useState(false);
    const [width, setWidth] = React.useState(280);
    return (
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="search-sidebar-trigger"
            onClick={() => setOpen((value) => !value)}
          >
            Toggle search sidebar
          </button>
          <button
            type="button"
            data-testid="search-sidebar-resize"
            onClick={() => setWidth((value) => (value === 280 ? 360 : 280))}
          >
            Resize shared sidebar
          </button>
        </div>
        <div
          data-testid="search-sidebar-shell"
          className="border-border1 bg-bg1 h-[420px] overflow-hidden border"
          style={{ width }}
        >
          {open && (
            <FilesSearchSidebar
              cwd={treeCwd}
              reloadKey={0}
              onOpenFile={(path) => console.log("[harness] search open", path)}
              onOpenInNewTab={(path) =>
                console.log("[harness] search new tab", path)
              }
              onClose={() => setOpen(false)}
            />
          )}
        </div>
      </div>
    );
  }

  // FIRST-PAINT fixture. Opening a file used to show chrome-white text for a
  // frame and then repaint in the code theme; the smoke asserts the fixed
  // behaviour the only way that is observable — mount the real editor inside
  // flushSync (React runs CodeMirror's creating layout effect before the browser
  // can paint) and inspect the DOM in that same task, i.e. exactly what the user
  // would first see. `mount()` warms the grammar the way every file read does
  // (prewarmFileSyntax) before mounting.
  const FIRST_PAINT_PATH = "src/first-paint.tsx";
  const FIRST_PAINT_SOURCE = [
    `import { useState } from "react";`,
    ``,
    `export function Badge({ label = "ok" }: { label?: string }) {`,
    `  const [count, setCount] = useState(0);`,
    `  return <b onClick={() => setCount(count + 1)}>{label}:{count}</b>;`,
    `}`,
  ].join("\n");

  function FirstPaintEditorFixture() {
    const [mounted, setMounted] = React.useState(false);
    React.useEffect(() => {
      const shikiTheme = resolveCodeTheme(getPrefs().codeTheme).shiki;
      (
        window as unknown as {
          __zerosFirstPaintEditor?: () => Promise<string>;
        }
      ).__zerosFirstPaintEditor = async () => {
        await prewarmSyntax(shikiLangForPath(FIRST_PAINT_PATH), shikiTheme);
        // The theme's own foreground — the editor chrome must already be using
        // it, not the app's --fg1, before any token lands.
        const fg = (await ensureThemeColors(shikiTheme))?.fg ?? "";
        flushSync(() => setMounted(true));
        return fg;
      };
    }, []);
    return (
      <div
        data-testid="file-editor-first-paint-host"
        className="h-[180px] w-[450px] overflow-hidden"
      >
        {mounted && (
          <CodeEditor value={FIRST_PAINT_SOURCE} filePath={FIRST_PAINT_PATH} />
        )}
      </div>
    );
  }

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
            <CodeEditor
              value={`${newLine}\n${indentedLine}`}
              filePath="src/shared.ts"
            />
          </div>
          <FirstPaintEditorFixture />
          <div data-testid="file-tree-host" className="h-[300px] w-[280px]">
            <WorkspaceFileTree
              cwd={treeCwd}
              initialSelectedPath="artifacts/api-server/src/index.ts"
              onOpenFile={(path) => console.log("[harness] tree open", path)}
              className="h-full"
            />
          </div>
          <SearchSidebarFixture />
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
