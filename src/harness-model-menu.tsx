// Standalone development harness — NOT part of the shipped app.
//
// An isolated repro page for the composer ModelPill dropdown, served by
// `pnpm dev` at /harness-model-menu.html. It has its own entry point and is
// never imported by the renderer bundle; it exists so the pill's popover can
// be exercised without booting the whole shell.
import "../styles/zeros-tokens.css";
import "../styles/semantic-tokens.css";
import "../styles/globals.css";

// Seed the module-level caches BEFORE importing the components that read
// them at module load.
const agents = [
  {
    id: "claude",
    name: "Claude Code",
    version: "1.0.0",
    description: "",
    distribution: {},
    installed: true,
    authenticated: true,
  },
  {
    id: "codex",
    name: "Codex",
    version: "1.0.0",
    description: "",
    distribution: {},
    installed: true,
    authenticated: true,
  },
  {
    id: "cursor",
    name: "Cursor",
    version: "1.0.0",
    description: "",
    distribution: {},
    installed: true,
    authenticated: true,
  },
];
localStorage.setItem(
  "zeros.agent.registrySnapshot",
  JSON.stringify({ agents, at: Date.now() }),
);

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("./zeros/ui/primitives/tooltip");
  const { ModelPill, ComposerConcealedContext } = await import(
    "./zeros/agent/composer-pills"
  );
  const {
    composerOwnsFocus,
    shouldReclaimComposerFocus,
    OPEN_OVERLAY_SELECTOR,
  } = await import("./zeros/agent/composer-focus");

  function Harness() {
    const [value, setValue] = React.useState<string | null>(null);
    const editorRef = React.useRef<HTMLDivElement | null>(null);

    // Replicate agent-chat.tsx's "composer always focused" guardian VERBATIM,
    // with a contenteditable stand-in for the TipTap editor, so the
    // interaction between the guardian and the model-menu popover is the
    // same as in the app.
    React.useEffect(() => {
      const composerDom = editorRef.current;
      if (!composerDom) return;
      const onClick = (e: MouseEvent) => {
        if (e.detail === 0) return;
        const target = e.target as Element | null;
        const paneRoot = composerDom.closest("[data-pane-root]");
        const interactionInsidePane =
          !!paneRoot && !!target && paneRoot.contains(target);
        if (!interactionInsidePane) return;
        setTimeout(() => {
          const selection = window.getSelection();
          if (
            shouldReclaimComposerFocus({
              owns: composerOwnsFocus({
                chatId: null,
                activeChatId: null,
                composerConcealed: false,
              }),
              interactionInsidePane,
              composerHasFocus: composerDom.contains(document.activeElement),
              hasTextSelection:
                !!selection &&
                selection.rangeCount > 0 &&
                !selection.isCollapsed,
              hasOpenOverlay: !!document.querySelector(OPEN_OVERLAY_SELECTOR),
              activeElement: document.activeElement,
              paneRoot,
            })
          ) {
            composerDom.focus();
          }
        });
      };
      document.addEventListener("click", onClick, true);
      return () => document.removeEventListener("click", onClick, true);
    }, []);

    return (
      <TooltipProvider delayDuration={500} skipDelayDuration={0}>
        <ComposerConcealedContext.Provider value={false}>
          <div
            data-pane-root
            className="bg-bg1 flex h-screen flex-col justify-end gap-3 p-10"
          >
            <div
              ref={editorRef}
              contentEditable
              data-testid="fake-editor"
              suppressContentEditableWarning
              className="border-border2 text-fg1 min-h-10 border p-2"
            >
              type here
            </div>
            <div data-testid="pill-host">
              <ModelPill
                agentId="claude"
                initialize={null}
                value={value}
                onChange={(next) => {
                  setValue(next);
                  // Load-bearing, NOT debug noise: scripts/ui-smoke-composer.mjs
                  // reads the page's console and asserts on this exact prefix to
                  // prove a row click actually reaches onChange. A click that
                  // merely closed the menu without selecting would otherwise
                  // pass. Delete this line and `pnpm test:ui-smoke` goes red.
                  console.log("[harness] onChange", next);
                }}
                onSelectAgentModel={() => {}}
                redirectCrossAgent
              />
            </div>
          </div>
        </ComposerConcealedContext.Provider>
      </TooltipProvider>
    );
  }

  createRoot(document.getElementById("root")!).render(<Harness />);
}

void main();
