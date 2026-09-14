// ──────────────────────────────────────────────────────────
// FileTypeIcon — the Files-tab's file-type glyphs, standalone
// ──────────────────────────────────────────────────────────
//
// The @-mention pill, tab strip and file tags show the same glyph as the
// Files tab. The tab renders Zeros' own sprite through @pierre/trees'
// `icons` config; this component renders the SAME sprite in the light DOM:
//
//   • FILE_ICON_SPRITE — the <symbol> sheet (injected ONCE into the light
//     DOM; every <use href="#…"> then resolves).
//   • createFileTreeIconResolver(FILE_ICON_TREE_CONFIG).resolveIcon(…)
//     — the library's own filename → symbol lookup, on our tables, so a
//     path resolves identically here and in the tree.
//
// Each symbol bakes its hue in as `var(--zeros-fi-<hue>)`; the palette is
// supplied inline on the <svg> (custom properties inherit into a <use>'s
// shadow tree). Folders/selection have no sprite glyph, so they use lucide.
// ──────────────────────────────────────────────────────────

import { Folder, MousePointer2 } from "lucide-react";
import { createFileTreeIconResolver } from "@pierre/trees";

import {
  FILE_ICON_PALETTE_STYLE,
  FILE_ICON_SPRITE,
  FILE_ICON_TREE_CONFIG,
} from "../../../shared/theme/file-icons";
import { cn } from "../../../shared/ui/cn";

const SPRITE_DOM_ID = "zeros-file-icon-sprite";

// Inject the sprite sheet exactly once. Idempotent + guarded on a DOM lookup
// so HMR / re-imports don't duplicate it. Runs at module eval (Electron
// renderer — document.body exists by the time app modules load).
function ensureSprite(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(SPRITE_DOM_ID)) return;
  const holder = document.createElement("div");
  holder.id = SPRITE_DOM_ID;
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText =
    "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
  holder.innerHTML = FILE_ICON_SPRITE;
  document.body.appendChild(holder);
}

ensureSprite();

const resolver = createFileTreeIconResolver(FILE_ICON_TREE_CONFIG);

export interface FileTypeIconProps {
  /** File/dir path or name used to resolve the glyph (e.g. "src/foo.ts"). */
  name: string;
  /** Mention kind — folders + selection use lucide; files use the sprite. */
  kind?: "file" | "folder" | "selection";
  size?: number;
  className?: string;
}

/** A single file-type glyph matching the Files tab. */
export function FileTypeIcon({
  name,
  kind = "file",
  size = 14,
  className,
}: FileTypeIconProps) {
  if (kind === "folder") {
    return (
      <Folder size={size} className={cn("text-fg2 shrink-0", className)} />
    );
  }
  if (kind === "selection") {
    return (
      <MousePointer2
        size={size}
        className={cn("text-fg2 shrink-0", className)}
      />
    );
  }
  const icon = resolver.resolveIcon("file-tree-icon-file", name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={cn("shrink-0", className)}
      style={FILE_ICON_PALETTE_STYLE}
      aria-hidden="true"
    >
      <use href={`#${icon.name}`} />
    </svg>
  );
}
