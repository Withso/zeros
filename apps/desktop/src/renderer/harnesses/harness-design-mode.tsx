// Production composer controls and transcript rows; only transport is synthetic.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerAttachmentMenu } from "../features/agent/composer-attachment-menu";
import { ComposerDesignTag } from "../features/agent/composer-design-tag";
import { ComposerDesignFrame, useComposerDesignFrame } from "../features/agent/composer-design-frame";
import type { DesignFrameAttachmentTarget } from "../features/agent/design-frame-attachment";
import { useDesignWorkspaceUiStore } from "../features/design-workspace/state/design-workspace-ui";
import { designWorkspaceSnapshotCache } from "../features/design-workspace/state/design-workspace-cache";
import { upsertProject } from "../state/projects-store";
import { notifyProjectsChanged, setWorkspaceRowsForTesting } from "../state/use-projects";
import { setComposerMode } from "../features/agent/composer-mode";
import { useComposerEditor } from "../features/agent/composer-editor/use-composer-editor";
import { EventRowRenderer } from "../features/agent/renderers/event-row-renderer";
import type { RendererContext } from "../features/agent/renderers/types";
import { useWorkspaceStore } from "../state/workspace-store";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { Button } from "../shared/ui/primitives/button";

const folder = "/design-mode-harness";
upsertProject({ repoRoot: folder, repoSlug: "design-harness", name: "Design harness" });
notifyProjectsChanged();
setWorkspaceRowsForTesting("design-harness", ["a", "b"].map(id => ({
  id, repoSlug: "design-harness", repoRoot: folder, path: id === "a" ? folder : `${folder}/other`,
  branch: `fixture-${id}`, baseBranch: "main", status: "in-progress", createdAt: 1, archivedAt: null,
  stashRef: null, prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null,
})));
for (const id of ["a", "b"]) {
  const directoryId = `design-${id}`;
  useDesignWorkspaceUiStore.getState().bindDirectory(id, directoryId);
  useDesignWorkspaceUiStore.getState().setSelection(id, id === "a" ? "phone.html" : "tablet.html", null, [], { frameSelected: true });
  designWorkspaceSnapshotCache.setData(id, {
    directoryId,
    frames: ["phone.html", "tablet.html"].map(file => ({ file, frameId: `frame_${id}_${file.split(".")[0]}`, sourceVersion: "a".repeat(24), title: file, width: 390, height: 844, x: 0, y: 0, z: 0 })),
    // Only the aggregate's identity and frame list are consumed by the composer.
  } as Parameters<typeof designWorkspaceSnapshotCache.setData>[1]);
}
useWorkspaceStore.setState({
  activeChatId: "a",
  chats: ["a", "b"].map((id) => ({
    id,
    folder: id === "a" ? folder : `${folder}/other`,
    agentId: "claude",
    agentName: "Claude",
    model: null,
    effort: "high",
    permissionMode: "plan",
    title: id,
    createdAt: 1,
    updatedAt: 1,
  })),
});
let revision = 0;
const bridge = {
  request: async (message: { params: { mode: "code" | "design" } }) => ({
    type: "WORKSPACE_RESPONSE",
    result: { mode: message.params.mode, revision: ++revision },
  }),
} as unknown as RuntimeClient;
const context = {
  isStreaming: false,
  lastMessageId: null,
  activeTurnStartedAt: 0,
  attachmentImagesActive: false,
  pendingQuestionToolCallIds: new Set(),
  editBaselines: new Map(),
  subagentChildren: new Map(),
} as RendererContext;
const tools = [
  "design_document_list",
  "design_document_open",
  "design_provenance_read",
  "design_transaction_apply",
  "design_lint",
  "design_capture",
  "design_history_undo",
];

const parked = new Map<string, DesignFrameAttachmentTarget | null | undefined>();
function FrameContextFixture({ chatId, mode, concealed }: { chatId: string; mode: "code" | "design"; concealed: boolean }) {
  const [submitted, setSubmitted] = useState<DesignFrameAttachmentTarget | null>(null);
  const context = useComposerDesignFrame({
    chatId, cwd: chatId === "a" ? folder : `${folder}/other`, intent: mode, active: !concealed,
    initialFrame: parked.get(chatId), onPin: useCallback(target => { parked.set(chatId, target); }, [chatId]),
  });
  return <div data-frame-context-fixture="" className="mt-2 flex flex-wrap gap-2">
    {context.selection && <ComposerDesignFrame selection={context.selection} onRemove={context.remove} onToggleScreenshot={context.toggleScreenshot} />}
    <Button onClick={() => useDesignWorkspaceUiStore.getState().setSelection(chatId, "phone.html", null, [], { frameSelected: true })}>Select phone</Button>
    <Button onClick={() => useDesignWorkspaceUiStore.getState().setSelection(chatId, "tablet.html", null, [], { frameSelected: true })}>Select tablet</Button>
    <Button onClick={() => useDesignWorkspaceUiStore.getState().setSelection(chatId, "phone.html", null, [], { frameSelected: false })}>Deselect frame</Button>
    <Button onClick={() => { const target = context.capture(); context.pin(target); setSubmitted(target); }}>Park frame send</Button>
    <Button onClick={() => context.pin(undefined)}>Use current selection</Button>
    <output aria-label="Submitted frame target">{submitted ? JSON.stringify(submitted) : "No submitted frame"}</output>
  </div>;
}

function Harness() {
  const [chatId, setChatId] = useState("a");
  const [concealed, setConcealed] = useState(false);
  const chat = useWorkspaceStore(
    (state) => state.chats.find((value) => value.id === chatId)!,
  );
  const composer = useComposerEditor({
    agentId: null,
    agentName: null,
    agentSupportsImage: false,
    modelId: null,
    cwd: folder,
    originUrl: null,
    availableCommands: [],
    placeholder: "Describe a design…",
    onSubmit: () => {},
  });
  return (
    <div data-zeros-root="" className="bg-bg1 text-fg1 min-h-screen p-6">
      <div className="mb-6 flex gap-2">
        <Button onClick={() => setChatId(chatId === "a" ? "b" : "a")}>
          Switch conversation
        </Button>
        <Button
          onClick={() =>
            useWorkspaceStore
              .getState()
              .dispatch({
                type: "SET_CHAT_COMPOSER_MODE",
                id: chatId,
                folder,
                mode: chat.composerMode === "design" ? "code" : "design",
                revision: ++revision,
              })
          }
        >
          Agent switch
        </Button>
        <Button onClick={() => setConcealed(!concealed)}>
          Toggle concealed
        </Button>
      </div>
      <div data-design-mode-fixture="" className="mx-auto max-w-xl">
        <div className="text-fg2 mb-4 text-sm">
          Create a landing page with a warm, minimal layout.
        </div>
        {tools.map((name, index) => (
          <EventRowRenderer
            key={name}
            ctx={context}
            message={{
              kind: "tool",
              id: name,
              toolCallId: name,
              title: name,
              toolKind: "mcp",
              status: "completed",
              createdAt: index,
              updatedAt: index,
              rawInput: {
                server: "design-draft",
                tool: name,
                arguments: { documentId: "frame:landing.html" },
              },
              rawOutput: {
                revision: "revision-1",
                documentId: "frame:landing.html",
                status: "completed",
              },
            }}
          />
        ))}
        <div
          className="border-border1 bg-bg2 mt-6 rounded-lg border p-3"
          {...(concealed ? { inert: "" } : {})}
        >
          {composer.editorContent}
          {composer.suggestionPopup}
          <FrameContextFixture key={chatId} chatId={chatId} mode={chat.composerMode ?? "code"} concealed={concealed} />
          <div className="mt-2 flex items-center gap-1">
            <ComposerAttachmentMenu
              concealed={concealed}
              onAttachFiles={() => {}}
              onAttachTranscript={() => {}}
              onLinkWorkspace={() => {}}
              onIntent={() => {}}
              designSelected={chat.composerMode === "design"}
              onDesign={() => {
                void setComposerMode(bridge, chatId, "design");
              }}
            />
            {chat.composerMode === "design" && (
              <ComposerDesignTag
                onRemove={() => {
                  void setComposerMode(bridge, chatId, "code");
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Harness />
  </TooltipProvider>,
);
