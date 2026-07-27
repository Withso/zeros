// ──────────────────────────────────────────────────────────
// Project-context chip — Phase 1 §2.9.5
// ──────────────────────────────────────────────────────────
//
// Sits in the chat header. Surfaces the project-context files
// the active agent is loading at this cwd — CLAUDE.md / AGENTS.md
// / .cursor/rules/* etc. — so the user can see "what does the
// agent know before I send my prompt?"
//
// Click expands a popover listing each file with size, mtime,
// short preview, and an Open-in-editor action. Read-only.
//
// File resolution lives main-side (electron/ipc/commands/agent-
// context.ts) — walking cwd → parents → home is filesystem-
// shaped work that has no business in the renderer.
// ──────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FileText, FolderOpen } from "lucide-react";

import {
  loadAgentContextFiles,
  type AgentContextFile,
  type AgentContextResult,
} from "../../native/native";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/primitives/popover";
import { Tooltip } from "@/zeros/ui/primitives";
import { useGitRefreshKey } from "@/shell/use-git-refresh-key";

interface Props {
  agentId: string | null | undefined;
  cwd: string | null | undefined;
}

const contextFilesCache = new Map<string, AgentContextResult>();
const MAX_CONTEXT_FILE_SNAPSHOTS = 64;

function contextKey(agentId: string, cwd: string): string {
  return JSON.stringify([agentId, cwd]);
}

function rememberContextFiles(key: string, data: AgentContextResult): void {
  contextFilesCache.delete(key);
  contextFilesCache.set(key, data);
  while (contextFilesCache.size > MAX_CONTEXT_FILE_SNAPSHOTS) {
    const oldest = contextFilesCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    contextFilesCache.delete(oldest);
  }
}

export function ProjectContextChip({ agentId, cwd }: Props) {
  const [open, setOpen] = useState(false);
  const key = agentId && cwd ? contextKey(agentId, cwd) : null;
  const refreshKey = useGitRefreshKey(cwd);
  const [live, setLive] = useState<{
    key: string;
    data: AgentContextResult;
  } | null>(null);
  const data = key
    ? live?.key === key
      ? live.data
      : (contextFilesCache.get(key) ?? null)
    : null;

  // Re-fetch on agent / cwd change. The fetch is debounced via the
  // single-pending guard below; rapid switching between chats
  // doesn't fire a stale callback.
  useEffect(() => {
    let cancelled = false;
    if (!agentId || !cwd || !key) return;
    loadAgentContextFiles({ agentId, cwd })
      .then((res) => {
        if (cancelled) return;
        rememberContextFiles(key, res);
        setLive({ key, data: res });
      })
      .catch(() => {
        // Keep the exact last-confirmed snapshot. A later git refresh or route
        // revisit retries without flashing another chat's count or a fake zero.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, cwd, key, refreshKey]);

  // 01c Wave 5: outside-click + Escape dismissal is now handled by
  // Radix Popover (Popover from src/zeros/ui/primitives/popover.tsx) instead
  // of the hand-rolled useEffect listeners that were here before.

  const files = data?.files ?? [];
  const count = files.length;

  // No agent / no cwd / nothing found → render nothing. The chip is
  // a discovery affordance; an empty chip would just be confusing
  // chrome.
  if (!agentId || !cwd) return null;
  if (count === 0) return null;

  const label = `${count} context file${count === 1 ? "" : "s"}`;

  return (
    <Popover open={open && count > 0} onOpenChange={setOpen}>
      <Tooltip label="Project context files">
        <PopoverTrigger asChild>
          <button
            type="button"
            className="text-fg2 bg-bg2-hover/50 hover:text-fg1 hover:bg-bg2-hover aria-expanded:text-fg1 aria-expanded:bg-bg2-hover inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-2 py-0.5 text-xs leading-none transition-colors duration-150 ease-out"
          >
            <FileText className="h-3 w-3" />
            <span>{label}</span>
            <ChevronDown className="ml-px h-3 w-3 opacity-50" />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="max-h-[60vh] w-[360px] max-w-[calc(100vw-32px)] overflow-auto p-0 py-1 text-xs"
      >
        <div className="border-border1 text-fg2 mb-1 border-b px-2.5 pt-1.5 pb-1 text-xs">
          Files {agentId} loads at this cwd
        </div>
        <div className="flex flex-col">
          {files.map((f) => (
            <ContextFileRow key={f.path} file={f} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ContextFileRow({ file }: { file: AgentContextFile }) {
  const sizeLabel = useMemo(() => formatSize(file.size), [file.size]);
  const scopeLabel = useMemo(() => {
    if (file.scope === "user") return "global";
    if (file.scope === "parent") return "parent";
    return "project";
  }, [file.scope]);

  const onOpen = () => {
    // The renderer has no direct "open in editor" affordance; we
    // copy the path to the clipboard so the user can paste it into
    // their editor of choice. A future revision can wire this to
    // `shell.openPath(file.path)` once the IPC surface for that
    // exists.
    void navigator.clipboard?.writeText(file.path);
  };

  return (
    <div className="border-border1 border-b px-2.5 py-1.5 last:border-b-0">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className="text-fg1 font-medium">{file.filename}</span>
        <span className="bg-bg3-hover text-fg2 rounded-sm px-1.5 py-px text-xs font-medium">
          {scopeLabel}
        </span>
        <span className="text-fg2 ml-auto text-xs">{sizeLabel}</span>
        <Tooltip label="Copy path">
          <button
            type="button"
            className="border-border1 text-fg2 hover:text-fg1 hover:bg-bg2-hover inline-flex cursor-pointer items-center rounded-sm border bg-transparent px-1 py-0.5"
            onClick={onOpen}
            aria-label="Copy path"
          >
            <FolderOpen className="h-3 w-3" />
          </button>
        </Tooltip>
      </div>
      <Tooltip label={file.path}>
        <div className="text-fg2 mb-1 overflow-hidden text-xs text-ellipsis whitespace-nowrap">
          {file.path}
        </div>
      </Tooltip>
      {file.preview && (
        <div className="text-fg2 relative max-h-[60px] overflow-hidden pb-1 text-xs break-words whitespace-pre-wrap">
          {file.preview}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
