// Real composer and edit surface; only the workspace transport is synthetic.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useComposerEditor } from "../features/agent/composer-editor/use-composer-editor";
import { TurnPromptHeader } from "../features/agent/turn-container";
import type { ComposerAttachment } from "../features/agent/composer-attachments";
import { Button } from "../shared/ui/primitives/button";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { useWorkspaceStore } from "../state/workspace-store";

const cwd = "/attachment-harness";
useWorkspaceStore.setState({
  chats: [{ id: "attachment-harness-chat", folder: cwd, agentId: "claude", agentName: "Claude", model: null, effort: "high", permissionMode: "auto", title: "Attachment edit", createdAt: 1, updatedAt: 1 }],
});
const body =
  "# Saved transcript\n\nThe staged transcript body must remain visible.";
const preview = {
  agentId: null,
  agentName: "Agent",
  userMessageCount: 1,
  lastMessageAt: 0,
};
const records = new Map<string, { relativePath: string; bytes: Uint8Array }>();
const uploads = new Map<string, Uint8Array>();
const operations: string[] = [];
let finishEdit: (() => void) | undefined;
let failEdit: (() => void) | undefined;

function saveRecord(
  id: string,
  name: string,
  bytes: Uint8Array,
  shared = false,
) {
  const record = {
    relativePath: `.context/${shared ? "shared" : "local"}/attachments/${id}/${name}`,
    bytes,
  };
  records.set(id, record);
  return record;
}
const original = saveRecord(
  "att-original",
  "notes.txt",
  new TextEncoder().encode("original attachment"),
);

setActiveBridge({
  executionIdentity: { kind: "local", sidecar: "active" },
  request: async (message: { op: string; params: Record<string, unknown> }) => {
    const p = message.params;
    operations.push(message.op);
    let result: unknown = {};
    if (message.op === "workspace.list") result = { workspaces: [] };
    if (message.op === "attachment.write") {
      const id = String(p.attachmentId);
      if (p.abort) {
        uploads.delete(String(p.uploadId));
        return {
          type: "WORKSPACE_RESPONSE",
          result: {
            pending: true,
            bytes: 0,
            relativePath: "",
            absolutePath: "",
            mimeType: p.mimeType,
          },
        };
      }
      if (!p.resolve) {
        const uploadId = String(p.uploadId);
        const bytes =
          uploads.get(uploadId) ?? new Uint8Array(Number(p.totalBytes));
        const chunk = Uint8Array.from(atob(String(p.base64)), (c) =>
          c.charCodeAt(0),
        );
        bytes.set(chunk, Number(p.offset));
        const received = Number(p.offset) + chunk.length;
        if (received < bytes.length) {
          uploads.set(uploadId, bytes);
          return {
            type: "WORKSPACE_RESPONSE",
            result: {
              pending: true,
              bytes: received,
              mimeType: p.mimeType,
              relativePath: "",
              absolutePath: "",
            },
          };
        }
        saveRecord(id, String(p.filename), bytes);
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
        mimeType: p.mimeType,
        skipped: p.resolve === true,
      };
    }
    if (message.op === "file.read") {
      const record = [...records.values()].find(
        (r) => r.relativePath === p.path,
      );
      result = record
        ? {
            kind: "text",
            path: p.path,
            bytes: record.bytes.length,
            content: new TextDecoder().decode(record.bytes),
          }
        : {
            kind: "error",
            path: p.path,
            bytes: 0,
            error: "file no longer exists",
          };
    }
    return { type: "WORKSPACE_RESPONSE", result };
  },
  onStatusChange: () => () => {},
  on: () => () => {},
} as unknown as RuntimeClient);

declare global {
  interface Window {
    composerAttachmentsHarness: {
      records: () => string[];
      operations: () => string[];
      finishEdit: () => void;
      failEdit: () => void;
    };
  }
}
window.composerAttachmentsHarness = {
  records: () => [...records.values()].map((r) => r.relativePath),
  operations: () => [...operations],
  finishEdit: () => finishEdit?.(),
  failEdit: () => failEdit?.(),
};

function ComposerHarness() {
  const composer = useComposerEditor({
    cwd,
    agentId: null,
    agentName: null,
    agentSupportsImage: false,
    modelId: null,
    originUrl: null,
    availableCommands: [],
    placeholder: "Message",
    onSubmit: () => {},
  });
  const restore = () => {
    const id = "att-restored";
    const name = "restored.txt";
    const bytes = new TextEncoder().encode(
      "Restored transcript from its saved shared file.",
    );
    saveRecord(id, name, bytes, true);
    const attachment: ComposerAttachment = {
      id,
      contextAttachmentId: id,
      name,
      kind: "text",
      mimeType: "text/plain",
      size: bytes.length,
      delivery: "reference",
      data: "",
      validation: { ok: true },
      preview,
      diskPath: `.context/local/attachments/${id}/${name}`,
    };
    composer.setContent({
      json: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "attachment",
                attrs: {
                  attachmentId: id,
                  name,
                  mimeType: attachment.mimeType,
                  kind: "text",
                },
              },
            ],
          },
        ],
      },
      attachments: [attachment],
    });
  };
  return (
    <>
      <div className="mb-4 flex gap-2">
        <Button
          onClick={() =>
            composer.insertTextAttachment({
              sourceKey: "transcript:test",
              name: "transcript.txt",
              text: body,
              preview,
            })
          }
        >
          Attach transcript
        </Button>
        <Button onClick={restore}>Restore transcript</Button>
        <Button onClick={() => composer.clear()}>Clear composer</Button>
      </div>
      <div className="border-border1 relative rounded-lg border p-3">
        {composer.editorContent}
      </div>
    </>
  );
}

function EditHarness() {
  const [editing, setEditing] = useState<string | null>("message-1");
  const [submitted, setSubmitted] = useState("");
  return (
    <>
      <TurnPromptHeader
        chatId="attachment-harness-chat"
        messageId="message-1"
        editingMessageId={editing}
        onRequestEdit={setEditing}
        originalText="Inspect the attached file"
        originalAttachments={[
          {
            name: "notes.txt",
            mimeType: "text/plain",
            kind: "file",
            delivery: "reference",
            size: original.bytes.length,
            attachmentId: "att-original",
            diskPath: original.relativePath,
          },
        ]}
        editAgentContext={{
          cwd,
          agentId: null,
          agentName: null,
          agentSupportsImage: false,
          modelId: null,
          availableCommands: [],
        }}
        onEdit={async (text, attachments) => {
          await new Promise<void>((resolve, reject) => {
            finishEdit = resolve;
            failEdit = () => reject(new Error("Upload failed"));
          });
          setSubmitted(
            JSON.stringify({
              text,
              attachments: attachments.map((a) => a.name),
            }),
          );
        }}
      >
        Inspect the attached file
      </TurnPromptHeader>
      <output data-submitted>{submitted}</output>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <div className="bg-bg1 min-h-screen p-12">
      {new URLSearchParams(location.search).has("edit") ? (
        <EditHarness />
      ) : (
        <ComposerHarness />
      )}
    </div>
  </TooltipProvider>,
);
