// ──────────────────────────────────────────────────────────
// FileTag — the filename/image pill shown on Read / Edit rows
// ──────────────────────────────────────────────────────────
//
// A small tag: [file-type glyph] filename. Same colored glyphs as the Files
// tab (FileTypeIcon). Per the Zeros Foundation tag recipe: bg `--bg1`, border
// `--border3`, hover `--bg2-hover`. Used on
// every file/image tool row so a Read of `foo.tsx` and an Edit of `foo.tsx`
// carry the identical pill.
// ──────────────────────────────────────────────────────────

import { cn } from "@/renderer/shared/ui/cn";
import { FileTypeIcon } from "../composer-editor/file-type-icon";
import { Pill } from "@/renderer/shared/ui/primitives";
import { forwardRef, type ComponentPropsWithoutRef } from "react";

function baseName(p: string): string {
  const cleaned = p.replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i === -1 ? cleaned : cleaned.slice(i + 1);
}

export const FileTag = forwardRef<HTMLButtonElement, {
  name: string;
  kind?: "file" | "folder";
} & ComponentPropsWithoutRef<typeof Pill>>(function FileTag({
  /** Full path or filename — drives both the glyph (by extension) and the
   *  displayed basename. */
  name,
  kind = "file",
  className,
  ...props
}, ref) {
  return (
    <Pill
      ref={ref}
      {...props}
      // The neutral inline pill: 20px, 12/16, 4px corners.
      className={cn("min-w-0 max-w-[440px]", className)}
    >
      <FileTypeIcon name={name} kind={kind} size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{baseName(name)}</span>
    </Pill>
  );
});
