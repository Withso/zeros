// ──────────────────────────────────────────────────────────
// ReviewChangesSection — the Review tab's Changes sub-tab
// ──────────────────────────────────────────────────────────
//
// The PR's cumulative diff (base...worktree — the branch is checked out
// locally, so the local diff IS the PR diff plus any not-yet-pushed work) as
// stacked, collapsible file cards: header (status chip · path · ±counts ·
// viewed toggle) + the @pierre diff body. Diff bodies mount lazily (only
// while expanded) so a 100-file PR stays snappy; marking a file viewed
// collapses it, GitHub-style. Fetching lives in the parent (ReviewView) so
// the sub-nav's file count and this list always agree.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { PatchDiff } from "@pierre/diffs/react";

import { Button, Tooltip } from "@/zeros/ui/primitives";
import { cn } from "@/zeros/ui/cn";
import { zerosDiffOptions } from "@/zeros/appearance/diff-theme";
import { useCodeTheme } from "@/zeros/appearance/use-code-theme";
import type { ChangedFile } from "./changes-parse";
import {
  Centered,
  DiffStat,
  ErrorCallout,
  FilePathLabel,
  RowChevron,
  ViewedToggle,
} from "./review-bits";

/** Above this many files the cards start collapsed — expanding 60 diffs at
 *  once is a scroll cliff, not a review. */
const AUTO_EXPAND_MAX_FILES = 25;

const STATUS_CHIP: Partial<
  Record<ChangedFile["status"], { label: string; cls: string }>
> = {
  added: { label: "New", cls: "bg-green-bg text-green-fg" },
  untracked: { label: "New", cls: "bg-green-bg text-green-fg" },
  deleted: { label: "Deleted", cls: "bg-red-bg text-red-fg" },
  renamed: { label: "Renamed", cls: "bg-violet-bg text-violet-fg" },
};

export function ReviewChangesSection({
  files,
  loading,
  error,
  baseBranch,
  onRetry,
}: {
  files: ChangedFile[];
  loading: boolean;
  error: string | null;
  baseBranch: string;
  onRetry: () => void;
}) {
  const codeTheme = useCodeTheme();
  // Per-path UI state survives silent refreshes (files array identity churns).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const autoCollapsed = files.length > AUTO_EXPAND_MAX_FILES;

  // Seed collapse state per file-set: on a big PR everything starts
  // collapsed. A live refresh that adds/removes files only seeds the NEW
  // paths (auto-collapse when big) and prunes gone ones — the user's manual
  // expand/collapse choices on existing files survive the refresh.
  const signature = useMemo(() => files.map((f) => f.path).join("\n"), [files]);
  const seenPaths = useRef<Set<string> | null>(null);
  useEffect(() => {
    const paths = new Set(files.map((f) => f.path));
    const seen = seenPaths.current;
    if (seen === null) {
      seenPaths.current = paths;
      setCollapsed(autoCollapsed ? new Set(paths) : new Set());
      return;
    }
    seenPaths.current = paths;
    setCollapsed((prev) => {
      const next = new Set<string>();
      for (const p of prev) if (paths.has(p)) next.add(p);
      if (autoCollapsed) {
        for (const p of paths) if (!seen.has(p)) next.add(p);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature is the files identity
  }, [signature, autoCollapsed]);

  const diffOptions = useMemo(
    // Our own card header replaces the in-diff file header row.
    () => zerosDiffOptions({ codeThemeId: codeTheme, disableFileHeader: true }),
    [codeTheme],
  );

  if (loading && files.length === 0)
    return <div className="min-h-24" aria-busy="true" />;
  if (error && files.length === 0)
    return (
      <div className="p-3">
        <ErrorCallout text={error} onRetry={onRetry} />
      </div>
    );
  if (files.length === 0)
    return (
      <Centered>
        No changes vs {baseBranch}. New commits appear here as the branch moves.
      </Centered>
    );

  const totals = files.reduce(
    (acc, f) => {
      acc.additions += f.additions;
      acc.deletions += f.deletions;
      return acc;
    },
    { additions: 0, deletions: 0 },
  );
  const allCollapsed = files.every((f) => collapsed.has(f.path));

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleViewed = (path: string) =>
    setViewed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        setCollapsed((c) => {
          const n = new Set(c);
          n.delete(path);
          return n;
        });
      } else {
        next.add(path);
        // GitHub behavior: viewed → collapse the card out of the way.
        setCollapsed((c) => new Set(c).add(path));
      }
      return next;
    });

  return (
    <div className="flex flex-col gap-2 p-3">
      {/* Summary row */}
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-fg1 text-xs font-medium">
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <DiffStat additions={totals.additions} deletions={totals.deletions} />
        {viewed.size > 0 && (
          <span className="text-muted-fg text-xs tabular-nums">
            {viewed.size}/{files.length} viewed
          </span>
        )}
        <div className="flex-1" />
        <Tooltip
          label={allCollapsed ? "Expand all files" : "Collapse all files"}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() =>
              setCollapsed(
                allCollapsed ? new Set() : new Set(files.map((f) => f.path)),
              )
            }
          >
            {allCollapsed ? (
              <ChevronsUpDown className="size-3.5" />
            ) : (
              <ChevronsDownUp className="size-3.5" />
            )}
          </Button>
        </Tooltip>
      </div>
      {error && <ErrorCallout text={error} onRetry={onRetry} />}

      {files.map((f) => {
        const open = !collapsed.has(f.path);
        const chip = STATUS_CHIP[f.status];
        const isViewed = viewed.has(f.path);
        return (
          <div
            key={f.path}
            className={cn(
              "border-border1 overflow-hidden rounded-lg border",
              isViewed && "opacity-70",
            )}
          >
            <button
              type="button"
              onClick={() => toggle(f.path)}
              aria-expanded={open}
              className={cn(
                "hover:bg-bg1-hover flex h-9 w-full items-center gap-2 px-2.5 text-left transition-colors duration-120 ease-out",
                open && "border-border1 border-b",
              )}
            >
              <RowChevron open={open} />
              <FilePathLabel
                path={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              />
              {chip && (
                <span
                  className={cn(
                    "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
                    chip.cls,
                  )}
                >
                  {chip.label}
                </span>
              )}
              <div className="flex-1" />
              <DiffStat additions={f.additions} deletions={f.deletions} />
              <ViewedToggle
                viewed={isViewed}
                onToggle={() => toggleViewed(f.path)}
              />
            </button>
            {open &&
              (f.binary ? (
                <Centered>Binary file — no textual diff.</Centered>
              ) : f.patch ? (
                // content-visibility bounds this surface the way turn
                // containers bound the transcript (turn-container.tsx): a PR
                // auto-expands up to 25 unvirtualized diffs, and without the
                // boundary every off-screen one paid style/layout on each
                // scroll and seam-drag frame. `auto` remembers the rendered
                // height once measured; 240px estimates a never-rendered one.
                <div className="[content-visibility:auto] [contain-intrinsic-size:auto_0px_auto_240px]">
                  <PatchDiff patch={f.patch} options={diffOptions} />
                </div>
              ) : (
                <Centered>No textual diff to show.</Centered>
              ))}
          </div>
        );
      })}
    </div>
  );
}
