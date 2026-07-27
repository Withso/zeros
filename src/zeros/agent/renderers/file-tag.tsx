// ──────────────────────────────────────────────────────────
// FileTag — the filename/image pill shown on Read / Edit rows
// ──────────────────────────────────────────────────────────
//
// A small tag: [file-type glyph] filename. Same colored glyphs as the Files
// tab (FileTypeIcon). Per the Zeros Foundation tag recipe (user spec
// 2026-06-19): bg `--bg1`, border `--border3`, hover `--bg2-hover`. Used on
// every file/image tool row so a Read of `foo.tsx` and an Edit of `foo.tsx`
// carry the identical pill.
// ──────────────────────────────────────────────────────────

import { cn } from "@/zeros/ui/cn";
import { FileTypeIcon } from "../composer-editor/file-type-icon";

function baseName(p: string): string {
  const cleaned = p.replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i === -1 ? cleaned : cleaned.slice(i + 1);
}

export function FileTag({
  /** Full path or filename — drives both the glyph (by extension) and the
   *  displayed basename. */
  name,
  kind = "file",
  className,
}: {
  name: string;
  kind?: "file" | "folder";
  className?: string;
}) {
  return (
    <span
      className={cn(
        // Unified pill recipe (2026-07-05, per user): 20px tall, 4px radius —
        // shared with the turn-footer file pills and the composer pills.
        "inline-flex h-5 min-w-0 max-w-[440px] items-center gap-1.5 rounded-sm border border-border3 bg-bg1 px-1.5 text-xs text-fg2 transition-colors hover:bg-bg2-hover",
        className,
      )}
    >
      <FileTypeIcon name={name} kind={kind} size={13} className="shrink-0" />
      <span className="min-w-0 truncate">{baseName(name)}</span>
    </span>
  );
}
