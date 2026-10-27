// Browser-only fixture for the real editor, node views, and attachment I/O.
// The workspace transport keeps uploaded files in memory for reference previews.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

import { lazy, Suspense, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useComposerEditor,
  type ComposerEditorApi,
  type ComposerInitialContent,
} from "../features/agent/composer-editor/use-composer-editor";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { useWorkspaceStore } from "../state/store";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { acceptCloudWorkspaceDocument } from "../state/cloud-workspace-catalog";
import { fileMediaType } from "@zeros/protocol/file-media";

const query = new URLSearchParams(location.search);
const cwd = query.get("workspace") ?? "/composer-editor-harness";
const suggestionsFixture = query.has("suggestions");
const mediaFixture = query.has("media-preview");
const mediaReads: string[] = [];
let releaseSkills = () => {};
const skillsReady = query.has("late-skills") ? new Promise<void>(resolve => { releaseSkills = resolve; }) : Promise.resolve();
window.__releaseComposerSkills = () => releaseSkills();
const composerActionCalls: string[] = [];
const sourceContent = "---\nname: review-agent\n---\n# Review source\n\nReview carefully.";
const sourceCatalog = () => [
  { id: "review-agent", name: "Review Agent", description: "Review the source", icon: "FileText", body: "Review carefully.", path: `${cwd}/skills/review-agent/SKILL.md`, content: sourceContent },
  { id: "library-review", name: "Library Review", description: "Review from the provider library", icon: "FileText", body: "Library review.", path: "/home/fixture/.claude/skills/library-review/SKILL.md", content: "# Library source\n\nLibrary review." },
];
const SourceViewer = lazy(() => import("../shell/workbench/tabs/file-viewer").then(module => ({ default: module.FileViewer })));
if (suggestionsFixture) {
  window.__ZEROS_NATIVE__ = {
    on: () => () => {},
    invoke: async <T,>(op: string, args?: Record<string, unknown>) => {
      if (op === "skills_list") {
        composerActionCalls.push(op);
        await skillsReady;
        return sourceCatalog() as T;
      }
      if (op === "read_file") return readFixtureFile(String(args?.path)) as T;
      if (op === "git_list_files") return { files: ["src/App.tsx"] } as T;
      return null as T;
    },
  };
}
const cloudTarget = parseCloudWorkspaceKey(cwd);
if (cloudTarget) {
  acceptCloudWorkspaceDocument({
    id: cloudTarget.workspaceId,
    organizationId: cloudTarget.organizationId,
    teamId: cloudTarget.organizationId,
    createdBy: cloudTarget.organizationId,
    name: "Composer fixture",
    placement: "cloud",
    status: query.has("stopped") ? "stopped" : "ready",
    version: 1,
    error: null,
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
    deletedAt: null,
    capabilities: { canWrite: true, canEdit: true, canManage: false, canStart: true, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "composer", revision: "refs/heads/main" },
    generation: {
      number: 1,
      architecture: "x86_64",
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
      observedState: query.has("stopped") ? "stopped" : "running",
      lastObservedAt: null,
    },
  });
}
const records = new Map<
  string,
  { relativePath: string; bytes: Uint8Array; mimeType: string }
>();
const uploads = new Map<string, Uint8Array>();
const pendingWrites: Array<{
  filename: string;
  finish: (error?: string) => void;
}> = [];

window.__composerAttachmentTransport = {
  read: readFixtureFile,
  reads: () => mediaReads,
  pending: () => pendingWrites.map(({ filename }) => filename),
  releaseNext: (filename, error) => {
    const index = pendingWrites.findIndex((write) => write.filename === filename);
    if (index < 0) throw new Error(`No pending write for ${filename}`);
    pendingWrites.splice(index, 1)[0].finish(error);
  },
};

function readFixtureFile(path: string) {
  const record = [...records.values()].find(value => value.relativePath === path);
  const media = fileMediaType(path);
  return record ? {
    path, bytes: record.bytes.length,
    ...(media
      ? { kind: media.kind, dataUrl: `data:${media.mimeType};base64,${btoa(Array.from(record.bytes, byte => String.fromCharCode(byte)).join(""))}` }
      : { kind: "text", content: new TextDecoder().decode(record.bytes) }),
  } : path === "skills/review-agent/SKILL.md"
    ? { kind: "text", path, bytes: sourceContent.length, content: sourceContent }
    : { kind: "error", path, bytes: 0, error: "File not found" };
}

setActiveBridge({
  executionIdentity: { kind: "local", sidecar: "active" },
  request: async (message: { op: string; params: Record<string, unknown> }) => {
    const p = message.params;
    let result: unknown = {};
    if (message.op === "skills.list") {
      composerActionCalls.push(message.op);
      await skillsReady;
      result = { skills: sourceCatalog() };
    }
    if (message.op === "workspace.list") result = { workspaces: [] };
    if (message.op === "file.tree") result = { files: ["src/App.tsx"] };
    if (message.op === "attachment.write") {
      if (query.has("hold-uploads") && !p.resolve && !p.abort) {
        await new Promise<void>((resolve, reject) => {
          pendingWrites.push({
            filename: String(p.filename),
            finish: (error) => (error ? reject(new Error(error)) : resolve()),
          });
        });
      }
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
          relativePath: `.context/attachments/${id}/${name}`,
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
    if (message.op === "file.read") { mediaReads.push(String(p.path)); result = readFixtureFile(String(p.path)); }
    return { type: "WORKSPACE_RESPONSE", result };
  },
  onStatusChange: () => () => {},
  on: () => () => {},
} as unknown as RuntimeClient);

declare global {
  interface Window {
    __composerHarness?: ComposerEditorApi;
    __composerWorkbench: () => ReturnType<typeof useWorkspaceStore.getState>["workbenchByScope"];
    __setComposerActive: (active: boolean) => void;
    __setComposerAgent: (agentId: "claude" | "codex" | "cursor") => void;
    __composerActionCalls: string[];
    __releaseComposerSkills: () => void;
    __composerAttachmentTransport: {
      read: typeof readFixtureFile;
      reads: () => string[];
      pending: () => string[];
      releaseNext: (filename: string, error?: string) => void;
    };
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
  const [active, setActive] = useState(true);
  const [agentId, setAgentId] = useState<"claude" | "codex" | "cursor" | null>(suggestionsFixture ? "claude" : null);
  const workbench = useWorkspaceStore(state => state.workbenchByScope[cwd]);
  const tab = workbench?.tabs.find(tab => tab.id === workbench.activeId);
  const composer = useComposerEditor({
    agentId,
    agentName: null,
    agentSupportsImage: true,
    modelId: null,
    cwd,
    attachmentImagesActive: active,
    originUrl: null,
    availableCommands: suggestionsFixture ? [{ name: "review-agent", description: "Review the source", kind: "skill" }, { name: "model", description: "A skill sharing a built-in name", kind: "skill" }] : [],
    placeholder: "Message",
    onSubmit: () => { composerActionCalls.push("submit"); },
    onSlashCommand: name => {
      if (name !== "model") return false;
      composerActionCalls.push("model-action");
      return true;
    },
    initialContent,
  });
  useLayoutEffect(() => {
    window.__composerHarness = composer;
    window.__composerWorkbench = () => useWorkspaceStore.getState().workbenchByScope;
    window.__setComposerActive = setActive;
    window.__setComposerAgent = setAgentId;
    window.__composerActionCalls = composerActionCalls;
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
      {(suggestionsFixture || mediaFixture) && tab?.filePath && <Suspense fallback={null}>
        <div data-testid="composer-source-viewer" className="border-border1 mt-4 h-96 overflow-hidden rounded-md border">
          <SourceViewer tabId={tab.id} cwd={cwd} path={tab.filePath} active={active}
            workspaceId={null} refreshKey={0} skillSource={tab.skillSource} readOnly={!!tab.skillSource}
            viewerMode={tab.viewerMode} onOpenPath={() => {}}
            onViewerModeChange={viewerMode => useWorkspaceStore.getState().dispatch({ type: "UPDATE_WORKBENCH_TAB", id: tab.id, scope: cwd, updates: { viewerMode } })} />
        </div>
      </Suspense>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Harness />
  </TooltipProvider>,
);
