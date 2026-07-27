// ──────────────────────────────────────────────────────────
// review-bits — small shared pieces of the Review tab surfaces
// ──────────────────────────────────────────────────────────
//
// State badge, check glyphs, author avatars, collapsible group headers,
// empty/error states — one place so the four sections (changes /
// commits / checks / reviews) stay visually identical. Recipes follow
// styles/zeros-foundation.md (§3 surface map, §4 components, §8 radius/motion).

import React, { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  GitMerge,
} from "lucide-react";

import type { PR, PrCheck } from "../../native/git";
import { Avatar, AvatarFallback, AvatarImage } from "@/zeros/ui/primitives";
import { cn } from "@/zeros/ui/cn";
import { ZerosSpinner } from "@/loaders";
import { checkOutcome, type CheckOutcome } from "./review-model";

// ── PR state badge ───────────────────────────────────────────

/** Filled status chip for the PR lifecycle — status colors come from the
 *  semantic families (§2.4): open→green, merged→violet, closed→red. Draft is
 *  a neutral chip (not a status). */
export function PrStateBadge({ state }: { state: PR["state"] }) {
  const map: Record<PR["state"], { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "bg-bg2-hover text-fg2" },
    ready: { label: "Open", cls: "bg-green-bg text-green-fg" },
    merged: { label: "Merged", cls: "bg-violet-bg text-violet-fg" },
    closed: { label: "Closed", cls: "bg-red-bg text-red-fg" },
  };
  const m = map[state];
  return (
    <span
      className={cn(
        "text-2xxs inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 font-medium",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}

// ── check glyphs ─────────────────────────────────────────────

/** Status icon for one check row. Skipped/cancelled get their own glyphs so a
 *  "passed" group with skips reads honestly. */
export function CheckGlyph({ check }: { check: PrCheck }) {
  if (check.conclusion === "skipped")
    return <CircleSlash className="text-muted-fg size-3.5 shrink-0" />;
  const outcome = checkOutcome(check);
  return <OutcomeGlyph outcome={outcome} />;
}

export function OutcomeGlyph({ outcome }: { outcome: CheckOutcome }) {
  if (outcome === "passed")
    return <CircleCheck className="text-green-primary size-3.5 shrink-0" />;
  if (outcome === "failed")
    return <CircleX className="text-red-primary size-3.5 shrink-0" />;
  return (
    <ZerosSpinner
      size={14}
      tone="inherit"
      label="Running"
      className="text-yellow-primary shrink-0"
    />
  );
}

// ── avatars ──────────────────────────────────────────────────

/** Small author avatar with an initial fallback. */
export function AuthorAvatar({
  login,
  avatarUrl,
  className,
}: {
  login: string;
  avatarUrl: string | null;
  className?: string;
}) {
  return (
    <Avatar size="sm" className={cn("size-5", className)}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={login} /> : null}
      <AvatarFallback className="text-[10px] uppercase">
        {login.slice(0, 1) || "?"}
      </AvatarFallback>
    </Avatar>
  );
}

// ── collapsible group header ─────────────────────────────────

/** "Failed 2 ⌄" — the Checks tab's group rows and the Changes tab's file
 *  headers share this affordance. */
export function GroupHeader({
  label,
  count,
  open,
  onToggle,
  tone = "default",
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  tone?: "default" | "failure" | "pending" | "success";
}) {
  const toneCls =
    tone === "failure"
      ? "text-red-primary"
      : tone === "pending"
        ? "text-yellow-primary"
        : tone === "success"
          ? "text-green-primary"
          : "text-fg1";
  return (
    <button
      type="button"
      onClick={onToggle}
      className="hover:bg-bg1-hover flex h-8 w-full items-center gap-2 px-3 text-left transition-colors duration-120 ease-out"
    >
      <ChevronDown
        className={cn(
          "text-fg2 size-3.5 shrink-0 transition-transform duration-120 ease-out",
          !open && "-rotate-90",
        )}
      />
      <span className={cn("text-xs font-medium", toneCls)}>{label}</span>
      <span className="text-muted-fg text-xs tabular-nums">{count}</span>
    </button>
  );
}

// ── empty / error ────────────────────────────────────────────

export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-fg px-3 py-6 text-center text-xs">
      {children}
    </div>
  );
}

/** Filled error callout (§4.8) with an optional retry. */
export function ErrorCallout({
  text,
  onRetry,
}: {
  text: string;
  onRetry?: () => void;
}) {
  return (
    <div className="bg-red-bg text-red-fg flex items-start gap-2 rounded-md px-3 py-2 text-xs">
      <span className="min-w-0 flex-1 break-words">{text}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-sm px-1.5 py-0.5 font-medium underline-offset-2 transition-colors duration-120 ease-out hover:underline"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function ReviewEmptyState({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-10 text-center">
      <GitMerge className="text-fg2 size-7" />
      <p className="text-fg1 m-0 text-sm font-medium">{title}</p>
      <p className="text-fg2 m-0 max-w-[420px] text-xs leading-[1.55]">
        {subtitle}
      </p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ── viewed toggle (Changes) ──────────────────────────────────

/** Round "mark viewed" check chip on each file card header. */
export function ViewedToggle({
  viewed,
  onToggle,
}: {
  viewed: boolean;
  onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={viewed}
      aria-label={viewed ? "Mark as not viewed" : "Mark as viewed"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cn(
        "flex size-4.5 shrink-0 items-center justify-center rounded-sm border transition-colors duration-120 ease-out",
        viewed
          ? "bg-green-bg text-green-fg border-transparent"
          : "border-border3 text-fg2 hover:border-border4",
      )}
    >
      {(viewed || hover) && <Check className="size-3" />}
    </button>
  );
}

// ── misc ─────────────────────────────────────────────────────

/** Directory-muted path: "src/shell/" in fg2 + "file.tsx" in fg1. */
export function FilePathLabel({ path }: { path: string }) {
  const idx = path.lastIndexOf("/");
  const dir = idx >= 0 ? path.slice(0, idx + 1) : "";
  const name = idx >= 0 ? path.slice(idx + 1) : path;
  return (
    <span className="min-w-0 truncate font-mono text-xs">
      {dir && <span className="text-fg2">{dir}</span>}
      <span className="text-fg1">{name}</span>
    </span>
  );
}

/** "+12 −4" plus/minus pair, tabular. */
export function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className={cn("shrink-0 text-xs tabular-nums", className)}>
      {additions > 0 && (
        <span className="text-green-primary">+{additions}</span>
      )}
      {additions > 0 && deletions > 0 && <span> </span>}
      {deletions > 0 && <span className="text-red-primary">−{deletions}</span>}
    </span>
  );
}

/** Chevron for expandable rows. */
export function RowChevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronDown className="text-fg2 size-3.5 shrink-0" />
  ) : (
    <ChevronRight className="text-fg2 size-3.5 shrink-0" />
  );
}
