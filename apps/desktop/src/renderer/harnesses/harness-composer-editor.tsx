// Browser-only fixture for the real editor, node views, and attachment I/O.
// The workspace transport keeps uploaded files in memory for reference previews.
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
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";

const cwd = "/composer-editor-harness";
const records = new Map<
  string,
  { relativePath: string; bytes: Uint8Array; mimeType: string }
>();
const uploads = new Map<string, Uint8Array>();

setActiveBridge({
  request: async (message: { op: string; params: Record<string, unknown> }) => {
    const p = message.params;
    let result: unknown = {};
    if (message.op === "workspace.list") result = { workspaces: [] };
    if (message.op === "attachment.write") {
      const id = String(p.attachmentId);
      const uploadId = String(p.uploadId);
      const pending = (bytes: number) => ({
        type: "WORKSPACE_RESPONSE",
        result: {
          pending: true,
          bytes,
          relativePath: "",
          absolutePath: "",
          mimeType: p.mimeType,
        },
      });
      if (p.abort) {
        uploads.delete(uploadId);
        return pending(0);
      }
      if (!p.resolve) {
        const chunk = Uint8Array.from(atob(String(p.base64)), (c) =>
          c.charCodeAt(0),
        );
        const bytes =
          uploads.get(uploadId) ??
          new Uint8Array(Number(p.totalBytes ?? chunk.length));
        const offset = Number(p.offset ?? 0);
        bytes.set(chunk, offset);
        if (offset + chunk.length < bytes.length) {
          uploads.set(uploadId, bytes);
          return pending(offset + chunk.length);
        }
        const name = String(p.filename).replace(/[^a-zA-Z0-9._-]+/g, "_");
        records.set(id, {
          relativePath: `.context/local/attachments/${id}/${name}`,
          bytes,
          mimeType: String(p.mimeType),
        });
        uploads.delete(uploadId);
      }
      const record = records.get(id);
      if (!record)
        return {
          type: "WORKSPACE_ERROR",
          code: "VALIDATION_FAILED",
          message: "The saved attachment is not available",
        };
      result = {
        relativePath: record.relativePath,
        absolutePath: `${cwd}/${record.relativePath}`,
        bytes: record.bytes.length,
        mimeType: record.mimeType,
        skipped: p.resolve === true,
      };
    }
    if (message.op === "file.read") {
      const record = [...records.values()].find(
        (value) => value.relativePath === p.path,
      );
      result = record
        ? {
            path: p.path,
            bytes: record.bytes.length,
            ...(record.mimeType.startsWith("image/")
              ? {
                  kind: "image",
                  dataUrl: `data:${record.mimeType};base64,${btoa(
                    Array.from(record.bytes, (byte) =>
                      String.fromCharCode(byte),
                    ).join(""),
                  )}`,
                }
              : {
                  kind: "text",
                  content: new TextDecoder().decode(record.bytes),
                }),
          }
        : { kind: "error", path: p.path, bytes: 0, error: "File not found" };
    }
    return { type: "WORKSPACE_RESPONSE", result };
  },
  onStatusChange: () => () => {},
  on: () => () => {},
} as unknown as RuntimeClient);

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
    cwd,
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
