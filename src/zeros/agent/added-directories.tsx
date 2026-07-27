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

import { Button, cn } from "../ui";
import { Tooltip } from "@/zeros/ui/primitives";

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
            // Inside the composer card (bg-bg2) the chip sits on --bg1 so it reads
            // as a recessed token, not another raised surface.
            className="inline-flex max-w-[260px] items-center gap-1.5 rounded-sm border border-border1 bg-bg1 py-1 pl-2 pr-1 text-xs text-fg2"
          >
            <Folder size={13} className="shrink-0 text-fg2" />
            <span className="min-w-0 truncate text-fg1">{baseName(dir)}</span>
            <Tooltip label="Remove">
              <Button
                type="button"
                variant="ghost"
                aria-label={`Remove directory access: ${dir}`}
                onClick={() => onRemove(dir)}
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-fg2",
                  "hover:bg-bg1-hover hover:text-fg1",
                )}
              >
                <X size={12} />
              </Button>
            </Tooltip>
          </span>
        </Tooltip>
      ))}
    </div>
  );
}
