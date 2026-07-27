// ──────────────────────────────────────────────────────────
// PermissionCard — the ONE permission surface (2026-07-02 redesign)
// ──────────────────────────────────────────────────────────
//
// Replaces BOTH the inline permission cluster and the global
// PermissionBar. There is now exactly one permission surface, and it
// renders IN PLACE OF the composer while a decision is pending — no
// inline card, no fallback. Design per the mockup:
//
//   ┌─────────────────────────────────────────────────────────┐
//   │ Do you want to run this command?                        │
//   │ >_  <label>            <the actual command, monospace>  │
//   │ ┌─────────────────────────────────────────────────┐ ↵  │
//   │ │ Yes                                              │    │
//   │ ├─────────────────────────────────────────────────┤ ⌘↵ │
//   │ │ Yes, and don't ask again for: <command>          │    │
//   │ ├─────────────────────────────────────────────────┤ ⌫  │
//   │ │ No                                               │    │
//   │ └─────────────────────────────────────────────────┘    │
//   └─────────────────────────────────────────────────────────┘
//
// Card chrome matches the composer's frame (bg2 + border1 + rounded-lg)
// since it takes the composer's slot. Buttons are full-width stacked
// rows with a keyboard-shortcut hint. Shortcuts: Enter = Yes,
// ⌘/Ctrl+Enter = don't-ask-again, Backspace/Delete = No.
//
// The wire response is unchanged — every button routes through the same
// `onRespond` the old surfaces used, so approve/reject semantics (incl.
// Claude "Deny keeps the turn") are preserved. The PermissionOptionKinds
// collapse by `kind`, so Claude (allow_once/allow_always/reject_once) and
// Codex (accept/acceptForSession/decline/cancel) render identically as 3
// buttons; Codex's extra reject_always ("cancel") is dropped.
//
// ONE exception, Claude only: when the always-allow can be persisted to
// project settings the adapter also sends `allow_always_project`, and we show
// a FOURTH button — "Allow for this chat" (Zeros chat-scoped) vs "Allow for
// this project" (writes `.claude/settings.local.json`). Absent that kind the
// layout is unchanged, so Codex/Cursor are untouched.
// ──────────────────────────────────────────────────────────

import { memo, useEffect, useRef } from "react";
import { FilePen, FileText, Terminal, Wrench } from "lucide-react";

import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../bridge/agent-events";
import { isInFocusedPane } from "./pane-focus";
import { newPolicyId, type PolicyRule } from "./policies";

/** Ignore card shortcuts for a beat after mount / request swap — long enough
 *  to absorb a keystroke already in flight when the card replaces the
 *  composer, short enough to be imperceptible to a user reading the prompt. */
const KEYBOARD_ARM_MS = 250;

interface PermissionCardProps {
  request: RequestPermissionRequest;
  onRespond: (response: RequestPermissionResponse) => void;
  /** Record a sticky chat policy when the user picks "don't ask again"
   *  so future matching requests auto-approve without re-prompting. */
  onRecordPolicy?: (rule: PolicyRule) => void;
  chatId?: string | null;
  /** The chat's working dir — used to show file paths workspace-relative
   *  (Claude's read/edit file_path is absolute). */
  cwd?: string | null;
}

interface Described {
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** Short human label for the action (agent-supplied description/reason). */
  label: string | null;
  /** The concrete thing being run/changed — a command, or a file path. */
  detail: string | null;
  /** The raw command, when present — used in the "don't ask again for: …" label. */
  command: string | null;
}

/** Show a tool's file path workspace-relative. Claude's read/edit tools pass
 *  an ABSOLUTE `file_path`; rendered raw it truncates to a useless home-dir
 *  prefix (`/Users/…/wo…`), hiding the file. Stripping the chat's cwd reveals
 *  the meaningful in-repo path (`src/engine/…/adapter.ts`) — the same way the
 *  rest of the app shows file refs. Paths outside cwd are shown unchanged. */
export function relativizePath(
  path: string,
  cwd: string | null | undefined,
): string {
  if (!cwd) return path;
  const root = cwd.replace(/\/+$/, "");
  if (path === root) return path;
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** Pull a title + icon + label + command out of the canonical request.
 *  Lenient about field names — Codex uses `command`/`reason`, Claude Bash
 *  uses `command`/`description`, reads/edits use `file_path`/`path`.
 *  Exported for unit tests (also avoids shadowing vitest's `describe`). */
export function describePermission(
  request: RequestPermissionRequest,
  cwd: string | null | undefined,
): Described {
  const tc = request.toolCall;
  const raw = (tc.rawInput ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v : null;

  const command = str(raw.command);
  const label = str(raw.description) ?? str(raw.reason);
  // The file the tool names (the "file ref"), made workspace-relative for a
  // readable, right-truncatable detail. Shared by the edit + generic branches.
  // Field varies by tool: file_path (Read/Write/Edit), notebook_path
  // (NotebookEdit), path (LS / a Glob/Grep search dir).
  const rawPath = str(raw.file_path) ?? str(raw.notebook_path) ?? str(raw.path);
  const path = rawPath ? relativizePath(rawPath, cwd) : null;
  // A single approval can name MULTIPLE files — Codex applies one patch that
  // spans several files in a single gate (Claude & Codex-exec stay one file
  // per call). `filePaths` is the engine-supplied list; relativize each so a
  // count row reads cleanly and a lone entry can stand in for `path`.
  const filePaths = Array.isArray(raw.filePaths)
    ? (raw.filePaths as unknown[])
        .filter(
          (p): p is string => typeof p === "string" && p.trim().length > 0,
        )
        .map((p) => relativizePath(p, cwd))
    : [];
  const fileCount = filePaths.length;
  // The one file to show when the approval names exactly one (either a single
  // `file_path` tool, or a one-file patch).
  const singleFilePath = path ?? (fileCount === 1 ? filePaths[0] : null);
  const kind = tc.kind;

  if (kind === "execute" || command) {
    return {
      title: "Do you want to run this command?",
      Icon: Terminal,
      label: label ?? str(tc.title),
      detail: command,
      command,
    };
  }
  if (kind === "edit") {
    // Multi-file patch: a single path would misrepresent the blast radius, so
    // summarize by count ("Apply changes to 3 files?" · "Edit 3 files") and
    // drop the path detail. One file keeps the familiar path row.
    if (fileCount > 1) {
      return {
        title: `Apply changes to ${fileCount} files?`,
        Icon: FilePen,
        label: `Edit ${fileCount} files`,
        detail: null,
        command: null,
      };
    }
    return {
      title: "Do you want to apply this change?",
      Icon: FilePen,
      label: label ?? "Edit",
      detail: singleFilePath,
      command: null,
    };
  }
  // Everything else — including Claude's Read and any tool that names a file.
  // When we have a path, surface it (the file ref) next to a file icon so the
  // user sees WHICH file is touched, not just the tool name; otherwise the
  // neutral wrench + title (MCP calls / tools with no file target).
  // A multi-file variant (e.g. a batched read/grep) collapses to a count with
  // the tool's verb — "Read 3 files" — rather than one arbitrary path.
  if (fileCount > 1) {
    return {
      title: "Do you want to allow this action?",
      Icon: FileText,
      label: `${str(tc.title) ?? label ?? "Access"} ${fileCount} files`,
      detail: null,
      command: null,
    };
  }
  return {
    title: "Do you want to allow this action?",
    Icon: singleFilePath ? FileText : Wrench,
    label: label ?? str(tc.title) ?? "Tool call",
    detail: singleFilePath,
    command: null,
  };
}

export const PermissionCard = memo(function PermissionCard({
  request,
  onRespond,
  onRecordPolicy,
  chatId,
  cwd,
}: PermissionCardProps) {
  const { title, Icon, label, detail, command } = describePermission(
    request,
    cwd,
  );

  const opts = request.options;
  const allowOnce = opts.find((o) => o.kind === "allow_once");
  const allowAlways = opts.find((o) => o.kind === "allow_always");
  // Claude-only: a project-scoped always-allow (persists to settings). Its
  // presence flips the always-allow copy to the scoped "Allow for this chat /
  // project" pair; without it we keep the legacy "don't ask again" wording so
  // Codex/Cursor are unchanged.
  const allowProject = opts.find((o) => o.kind === "allow_always_project");
  const reject =
    opts.find((o) => o.kind === "reject_once") ??
    opts.find((o) => o.kind === "reject_always");
  const allowAlwaysLabel = allowProject
    ? "Allow for this chat"
    : command
      ? `Yes, and don't ask again for: ${command}`
      : "Yes, and don't ask again";

  const respondWith = (opt: PermissionOption | undefined) => {
    if (!opt) return;
    // Sticky "don't ask again": write a chat policy BEFORE responding so the
    // next matching request auto-resolves and never blinks this card.
    if (onRecordPolicy && chatId && opt.kind === "allow_always") {
      onRecordPolicy({
        id: newPolicyId(),
        chatId,
        toolKind: request.toolCall.kind ?? undefined,
        toolTitle: request.toolCall.title,
        decision: "allow",
        createdAt: Date.now(),
      });
    }
    onRespond({ outcome: { outcome: "selected", optionId: opt.optionId } });
  };

  // Keyboard: Enter = Yes · ⌘/Ctrl+Enter = don't-ask-again · Backspace/Del = No.
  // Bind once and read the latest handlers via a ref so the listener never
  // goes stale across re-renders. Guards — this card REPLACES the composer,
  // often mid-keystroke, and a gate must never be answered by accident:
  //   • keys aimed at another control (an input, an open menu/dialog, any
  //     focused element outside this card) belong to that control, not the
  //     gate — only body-level keys (or keys inside the card) answer it;
  //   • auto-repeats are ignored (holding Backspace in the composer at the
  //     moment the card lands would insta-deny);
  //   • a short arming delay absorbs the keystroke already in flight when
  //     the card mounts / a new request swaps in.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const armedAtRef = useRef(0);
  useEffect(() => {
    armedAtRef.current = performance.now() + KEYBOARD_ARM_MS;
  }, [request]);
  const actionsRef = useRef({
    allowOnce,
    allowAlways,
    allowProject,
    reject,
    respondWith,
  });
  actionsRef.current = {
    allowOnce,
    allowAlways,
    allowProject,
    reject,
    respondWith,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || performance.now() < armedAtRef.current) return;
      // Split panes: only the focused pane's card owns these window-level
      // keys — two visible cards must not both resolve on one Enter.
      if (!isInFocusedPane(rootRef.current)) return;
      const t = e.target as HTMLElement | null;
      const insideCard = !!t && !!rootRef.current?.contains(t);
      const aimedElsewhere =
        !!t &&
        t !== document.body &&
        t !== document.documentElement &&
        !insideCard;
      if (aimedElsewhere) return;
      // If one of the card's own buttons is focused (keyboard Tab), let ITS
      // native Enter/Space activation fire. Applying the global mapping here
      // would resolve "Allow once" regardless of which button is focused — so a
      // user who Tabbed to "No" and pressed Enter would APPROVE instead of deny.
      if (insideCard && t?.closest("button")) return;
      const a = actionsRef.current;
      if (e.key === "Enter") {
        e.preventDefault();
        // ⇧⌘/Ctrl+↵ → project (falls back to chat if not offered) ·
        // ⌘/Ctrl+↵ → chat · plain ↵ → once.
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
          a.respondWith(a.allowProject ?? a.allowAlways);
        } else if (e.metaKey || e.ctrlKey) {
          a.respondWith(a.allowAlways);
        } else {
          a.respondWith(a.allowOnce);
        }
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        a.respondWith(a.reject);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      ref={rootRef}
      className="border-border1 bg-bg2 flex w-full min-w-0 flex-col gap-3 rounded-lg border px-3.5 py-3"
    >
      <div className="text-fg1 text-sm font-medium">{title}</div>

      {(label || detail) && (
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
          {label && (
            <span className="text-fg1 max-w-[45%] shrink-0 truncate text-sm">
              {label}
            </span>
          )}
          {detail && (
            <span className="text-fg2 min-w-0 flex-1 truncate font-mono text-xs">
              {detail}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {allowOnce && (
          <PermRow
            label="Yes"
            hint="↵"
            onClick={() => respondWith(allowOnce)}
          />
        )}
        {allowAlways && (
          <PermRow
            label={allowAlwaysLabel}
            hint="⌘↵"
            onClick={() => respondWith(allowAlways)}
          />
        )}
        {allowProject && (
          <PermRow
            // Engine-supplied: "Allow for this project" (a scoped rule, e.g. a
            // Bash command) or "Allow all edits in this project" (edit tools).
            label={allowProject.name}
            hint="⇧⌘↵"
            onClick={() => respondWith(allowProject)}
          />
        )}
        {reject && (
          <PermRow label="No" hint="⌫" onClick={() => respondWith(reject)} />
        )}
      </div>
    </div>
  );
});

function PermRow({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Secondary-button recipe (RULES.md): bg1 fill + border3, hover → bg2 +
      // border4. Full-width row (label left, shortcut hint right).
      className="border-border3 bg-bg1 hover:border-border4 hover:bg-bg2 flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors duration-150 ease-out"
    >
      <span className="text-fg1 min-w-0 truncate text-sm">{label}</span>
      <span className="text-fg2 shrink-0 font-mono text-xs">{hint}</span>
    </button>
  );
}
