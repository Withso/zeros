// ──────────────────────────────────────────────────────────
// MentionPicker — autocomplete popover for the agent composer
// ──────────────────────────────────────────────────────────
//
// Dumb list + keyboard nav. Parent owns the composer text, detects the
// trigger, and passes us the filtered items. On pick we call back with
// the chosen item; parent handles text splicing.
// ──────────────────────────────────────────────────────────

import React, { useEffect, useRef } from "react";
import type { MentionItem, MentionKind } from "./mentions";
import type { SuggestionStatus } from "./composer-editor/suggestion";
// Same colored file-type glyphs as the Files tab + the inline pills.
import { FileTypeIcon } from "./composer-editor/file-type-icon";
import { Button } from "../ui";

interface MentionPickerProps {
  items: MentionItem[];
  /** Load state of the workspace file list (drives the empty-row copy). */
  status?: SuggestionStatus;
  highlightIndex: number;
  onHover: (index: number) => void;
  onPick: (item: MentionItem) => void;
}

const KIND_LABEL: Record<MentionKind, string> = {
  selection: "Selection",
  file: "File",
  folder: "Folder",
};

export function MentionPicker({
  items,
  status = "ready",
  highlightIndex,
  onHover,
  onPick,
}: MentionPickerProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the active item scrolled into view as the highlight moves.
  useEffect(() => {
    const node = listRef.current?.children[highlightIndex] as
      | HTMLElement
      | undefined;
    if (node) {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  // Mention picker — popover that opens ABOVE the composer card. User spec
  // (2026-06-08): match the slash-command picker EXACTLY — same bg-bg1
  // surface and bg-bg1-hover row highlight (the old bg-bg3 surface hid the
  // default top-item highlight because the active row used the same bg-bg3).
  const menuWrap =
    "absolute inset-x-0 bottom-[calc(100%+6px)] z-[25] overflow-hidden rounded-lg border border-border1 bg-bg1 shadow-lg";

  if (items.length === 0) {
    if (status === "loading") {
      return (
        <div className={menuWrap} aria-busy="true">
          <div className="h-8" />
        </div>
      );
    }
    const emptyLabel =
      status === "error" ? "Couldn't load files." : "No matches.";
    return (
      <div className={menuWrap}>
        <div className="text-fg2 p-3 text-xs">{emptyLabel}</div>
      </div>
    );
  }

  return (
    <div className={menuWrap}>
      <div className="border-border1 text-fg2 border-b px-3 py-1.5 text-xs">
        Mention · {items.length} result{items.length === 1 ? "" : "s"}
      </div>
      <div ref={listRef} className="max-h-[220px] overflow-y-auto">
        {items.map((item, i) => {
          const active = i === highlightIndex;
          return (
            <Button
              key={item.id}
              variant="ghost"
              type="button"
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                // mousedown (not click) so we beat the textarea blur.
                e.preventDefault();
                onPick(item);
              }}
              className={`text-fg1 hover:bg-bg1-hover flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left transition-[background] duration-150 ease-out ${
                active ? "!bg-bg1-hover" : ""
              }`}
            >
              {/* Single-line row like the slash picker: the Files-tab colored
                  file-type glyph, name, dir hint inline, kind label trailing. */}
              <FileTypeIcon
                name={item.query}
                kind={item.kind}
                size={14}
                className="shrink-0"
              />
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="text-fg1 shrink-0 text-xs">{item.label}</span>
                {item.hint && (
                  <span className="text-fg2 min-w-0 flex-1 overflow-hidden text-xs text-ellipsis whitespace-nowrap">
                    {item.hint}
                  </span>
                )}
              </div>
              <span className="text-fg3 shrink-0 text-xs">
                {KIND_LABEL[item.kind]}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
