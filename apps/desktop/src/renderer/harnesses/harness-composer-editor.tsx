// Browser-only fixture for the real editor, node views, and attachment I/O.
// No workspace means attachments stay in memory and never reach the engine.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  useComposerEditor,
  type ComposerEditorApi,
  type ComposerInitialContent,
} from "../features/agent/composer-editor/use-composer-editor";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";

declare global {
  interface Window {
    __composerHarness?: ComposerEditorApi;
  }
}

const initialContent: ComposerInitialContent | undefined = new URLSearchParams(
  location.search,
).has("attachment")
  ? {
      attachments: [
        {
          id: "last-file",
          name: "notes.txt",
          mimeType: "text/plain",
          kind: "text",
          data: "",
          text: "notes",
          size: 5,
          validation: { ok: true },
        },
      ],
      json: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "attachment",
                attrs: {
                  attachmentId: "last-file",
                  name: "notes.txt",
                  mimeType: "text/plain",
                  kind: "text",
                },
              },
            ],
          },
        ],
      },
    }
  : undefined;

function Harness() {
  const composer = useComposerEditor({
    agentId: null,
    agentName: null,
    agentSupportsImage: true,
    modelId: null,
    cwd: null,
    originUrl: null,
    availableCommands: [],
    placeholder: "Message",
    onSubmit: () => {},
    initialContent,
  });
  useLayoutEffect(() => {
    window.__composerHarness = composer;
    return () => {
      delete window.__composerHarness;
    };
  }, [composer]);

  return (
    <div data-zeros-root="" className="bg-bg1 text-fg1 min-h-screen p-4">
      <div
        data-testid="composer-host"
        className="border-border1 bg-bg2 relative w-[800px] max-w-full rounded-lg border p-4"
        {...composer.dragHandlers}
      >
        {composer.editorContent}
        {composer.suggestionPopup}
      </div>
      {composer.imagePreviewOverlay}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Harness />
  </TooltipProvider>,
);
