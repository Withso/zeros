// ──────────────────────────────────────────────────────────
// PrPicker — "#" autocomplete for referencing a GitHub PR
// ──────────────────────────────────────────────────────────
//
// Sibling of MentionPicker / SlashCommandPicker. Triggers on a "#" at a
// word boundary (like @-mentions); the parent (the composer editor,
// use-composer-editor.tsx) detects the trigger, fetches the repo's open
// PRs once via ghPrList, filters by the typed query, and on pick splices
// "#<number> " into the prompt.
// ──────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";
import { GitPullRequest } from "lucide-react";

import { Button } from "../ui";
import type { SuggestionStatus } from "./composer-editor/suggestion";

export interface PrPickerItem {
  number: number;
  title: string;
}

export interface HashTrigger {
  start: number;
  end: number;
  query: string;
}

/** Detect a `#<query>` PR reference at a word boundary before the caret.
 *  Mirrors detectMentionTrigger so "#" behaves like "@". */
export function detectHashTrigger(
  text: string,
  caret: number,
): HashTrigger | null {
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "#") {
      const before = i > 0 ? text[i - 1] : "";
      if (before && !/\s/.test(before)) return null;
      // Only fire while the query is empty or PR-reference-shaped (digits /
      // word chars) — a "#" with a space after it is just text.
      const query = text.slice(i + 1, caret);
      if (/\s/.test(query)) return null;
      return { start: i, end: caret, query };
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

/** Filter PRs by number prefix or title substring (case-insensitive). */
export function filterPrs(prs: PrPickerItem[], query: string): PrPickerItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return prs.slice(0, 10);
  return prs
    .filter(
      (pr) =>
        String(pr.number).startsWith(q) || pr.title.toLowerCase().includes(q),
    )
    .slice(0, 10);
}

export function PrPicker({
  items,
  status = "ready",
  highlightIndex,
  onHover,
  onPick,
}: {
  items: PrPickerItem[];
  /** Load state of the PR fetch (drives the empty-row copy). */
  status?: SuggestionStatus;
  highlightIndex: number;
  onHover: (index: number) => void;
  onPick: (item: PrPickerItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = listRef.current?.children[highlightIndex] as
      | HTMLElement
      | undefined;
    if (node) node.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  // Popover above the textarea — same geometry AND surface as the
  // mention/slash menus: bg1 (canvas) + border1 + shadow-lg, so all three
  // pickers read as one consistent "floating card" (was bg3, the lone
  // outlier in the picker family).
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
      status === "error"
        ? "Couldn't load pull requests."
        : "No open pull requests.";
    return (
      <div className={menuWrap}>
        <div className="text-fg2 p-3 text-xs">{emptyLabel}</div>
      </div>
    );
  }

  return (
    <div className={menuWrap}>
      <div className="border-border1 text-fg2 border-b px-3 py-1.5 text-xs">
        Pull request · {items.length} result{items.length === 1 ? "" : "s"}
      </div>
      <div ref={listRef} className="max-h-[220px] overflow-y-auto">
        {items.map((pr, i) => {
          const active = i === highlightIndex;
          return (
            <Button
              key={pr.number}
              variant="ghost"
              type="button"
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                // mousedown (not click) so we beat the textarea blur.
                e.preventDefault();
                onPick(pr);
              }}
              className={`text-fg1 hover:bg-bg1-hover flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left transition-[background] duration-150 ease-out ${
                active ? "!bg-bg1-hover [&_[data-icon]]:text-green-primary" : ""
              }`}
            >
              <GitPullRequest
                data-icon
                className="text-fg2 h-3.5 w-3.5 shrink-0"
              />
              <span className="text-fg2 shrink-0 text-xs tabular-nums">
                #{pr.number}
              </span>
              <span className="text-fg1 min-w-0 flex-1 overflow-hidden text-xs text-ellipsis whitespace-nowrap">
                {pr.title}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
