// ──────────────────────────────────────────────────────────
// AddedDirectories — context chips for Claude's `/add-dir`
// ──────────────────────────────────────────────────────────
//
// `/add-dir` (and the composer "+" → "Link workspaces" menu) grants Claude
// access to directories beyond the chat's own `folder` (the SDK
// `Options.additionalDirectories` / CLI `--add-dir`). Each granted directory
// shows as a removable chip INSIDE the composer card (top, next to attachment
// chips), so it reads as in-scope context for the prompt you're about to send.
//
// Purely presentational — adding flows through the WorkspaceDirectoryPicker
// dialog (the "+" menu / `/add-dir`); this only renders the result + the × to
// remove. State lives on the ChatThread (additionalDirectories) and is carried
// to the adapter via env on the next session respawn (Claude resumes, so the
// conversation survives).
// ──────────────────────────────────────────────────────────

import { Folder, X } from "lucide-react";

import { IconButton, Tooltip } from "@/renderer/shared/ui/primitives";

export interface AddedDirectoriesProps {
  /** Absolute paths Claude can additionally access (ChatThread.additionalDirectories). */
  dirs: string[];
  /** Remove one directory (the × on its chip). */
  onRemove: (dir: string) => void;
}

/** Last path segment of an absolute path, for the chip's primary label.
 *  Handles both POSIX and Windows separators; falls back to the full path for
 *  a root like "/". */
function baseName(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

export function AddedDirectories({ dirs, onRemove }: AddedDirectoriesProps) {
  if (dirs.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 pb-1"
      aria-label="Extra directories Claude can access"
    >
      {dirs.map((dir) => (
        <Tooltip key={dir} label={dir}>
          <span
            // The 24px control Pill's look, holding its own 20px remove button.
            className="border-border2 bg-bg2 text-fg1 inline-flex h-6 max-w-[260px] items-center gap-1 rounded-md border pr-0.5 pl-2 text-xs leading-4.5"
          >
            <Folder size={14} className="text-fg2 shrink-0" />
            <span className="min-w-0 truncate">{baseName(dir)}</span>
            <IconButton
              size="inline"
              label={`Remove directory access: ${dir}`}
              onClick={() => onRemove(dir)}
            >
              <X />
            </IconButton>
          </span>
        </Tooltip>
      ))}
    </div>
  );
}
