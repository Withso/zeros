// ──────────────────────────────────────────────────────────
// Settings UI primitives — one layout of grouped cards
// ──────────────────────────────────────────────────────────
//
// The shared visual vocabulary for every settings panel (User + Repo):
// rows in grouped cards — `bg1-bright`, a `border1` edge and dividers, 12px
// corners and 12 × 14 rows — with 13/18 medium names, 12/16 `fg3` hints and
// 28px controls right-aligned. Group titles are 13 medium `fg1` with an
// optional 12 `fg3` description. Flat sections retired with this layout.
//
// Build these ONCE; every panel composes them so User and Repo scopes
// read identically.
// ──────────────────────────────────────────────────────────

import React from "react";
import { Lock } from "lucide-react";
import { cn } from "@/renderer/shared/ui/cn";
import { badgeVariants } from "@/renderer/shared/ui/primitives/badge";
import { Button } from "@/renderer/shared/ui/primitives/button";

const NAME_CLS = "text-fg1 text-xs leading-4.5 font-medium";
const HINT_CLS = "text-fg3 text-3xxs leading-4";

// ── Section ──────────────────────────────────────────────

/** A titled section: a 13 medium heading (with an optional one-line
 *  description and a right-aligned action) 8px above its body, which is
 *  usually a `SettingsList` card. */
export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {(title || action || description) && (
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && <h2 className={cn(NAME_CLS, "m-0")}>{title}</h2>}
            {description && <p className={cn(HINT_CLS, "m-0")}>{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** The settings card: `--bg1-bright` fill (a step above bg1-highlight in
 *  dark, = bg2 in light) with a `--border1` edge and dividers, 12px corners,
 *  and 12 × 14 rows (`px-3.5` on the card, `[&>*]:py-3` on every row). Not
 *  `--bg3`: in light mode bg3 = bg1 = white and the card would vanish
 *  (check:ui guards this). Every `SettingsList` wears it. */
export const SETTINGS_CARD_LIST_CLS =
  "bg-bg1-bright border-border1 divide-border1 rounded-[calc(var(--radius-lg)*1.5)] border px-3.5 [&>*]:py-3";

/** 12px corners for the grouped card, DERIVED from the radius scale like
 *  menu-surface.ts's floating surfaces (1.5 × --radius-lg). Not
 *  `rounded-xl`: zeros-tokens.css resets `--radius-xl` to `initial` on
 *  purpose, so that class compiles to nothing (the card rendered with
 *  square corners, 2026-09-14). The grouped card is a larger surface than
 *  the 8px rows/chips inside it, hence the step up. */
export const SETTINGS_GROUP_RADIUS = "rounded-[calc(var(--radius-lg)*1.5)]";

/** Grouped settings card: an optional 13 medium `fg1` title and 12 `fg3`
 *  description 8px above the `SETTINGS_CARD_LIST_CLS` card. Groups are
 *  spaced 32px apart by the panel (`gap-8`). */
export function SettingsGroup({
  title,
  description,
  children,
  className,
  "aria-label": ariaLabel,
}: {
  title?: React.ReactNode;
  /** One short muted line under the heading (same 12px). */
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <section aria-label={ariaLabel} className={cn("flex flex-col gap-2", className)}>
      {(title || description) && (
        <div className="flex flex-col gap-0.5 px-0.5">
          {title && <h2 className={cn(NAME_CLS, "m-0")}>{title}</h2>}
          {description && <p className={cn(HINT_CLS, "m-0")}>{description}</p>}
        </div>
      )}
      <SettingsList>{children}</SettingsList>
    </section>
  );
}

/** A card of `SettingsRow` / `SettingsField` children separated by
 *  `border1` dividers. */
export function SettingsList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col divide-y", SETTINGS_CARD_LIST_CLS, className)}>
      {children}
    </div>
  );
}

// ── Rows ─────────────────────────────────────────────────

/** Label-left / control-right row. Optional hint sits under the label.
 *  Self-padded so dividers in a `SettingsList` breathe. */
export function SettingsRow({
  label,
  hint,
  htmlFor,
  leading,
  children,
  className,
  align = "center",
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  /** An avatar or icon 12px before the label block. */
  leading?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /** Vertical alignment of the control against the label block. */
  align?: "center" | "start";
}) {
  const labelCls = NAME_CLS;
  const text = (label || hint) && (
    <div className="flex min-w-0 flex-col gap-0.5">
      {label &&
        (htmlFor ? (
          <label htmlFor={htmlFor} className={labelCls}>
            {label}
          </label>
        ) : (
          <span className={labelCls}>{label}</span>
        ))}
      {hint && <span className={HINT_CLS}>{hint}</span>}
    </div>
  );
  return (
    <div
      className={cn(
        "flex justify-between gap-4 py-3",
        align === "center" ? "items-center" : "items-start",
        className,
      )}
    >
      {leading ? (
        <div className="flex min-w-0 items-center gap-3">
          {leading}
          {text}
        </div>
      ) : (
        text
      )}
      {children != null && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** Stacked field: label (+ optional hint) on top, full-width control below.
 *  For text inputs that need the row's full width. */
export function SettingsField({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5 py-3", className)}>
      {label && (
        <label htmlFor={htmlFor} className={NAME_CLS}>
          {label}
        </label>
      )}
      {children}
      {hint && <p className={cn(HINT_CLS, "m-0")}>{hint}</p>}
    </div>
  );
}

/** A right-aligned Save row to close a section. */
export function SettingsActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 pt-1">{children}</div>
  );
}

/** The one empty state for a section with nothing configured yet: one
 *  13/18 `fg2` line, with an optional 12 `fg3` hint. */
export function SettingsEmpty({
  title,
  hint,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 py-6 text-center">
      <p className="text-fg2 m-0 text-xs leading-4.5">{title}</p>
      {hint && <p className={cn(HINT_CLS, "m-0")}>{hint}</p>}
    </div>
  );
}

/** An empty collection in its card: one line and the action that creates
 *  the first item. */
export function SettingsEmptyCard({
  title,
  action,
}: {
  title: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "bg-bg1-bright border-border1 flex flex-col items-center justify-center gap-3 border px-3.5 py-6",
        SETTINGS_GROUP_RADIUS,
      )}
    >
      <p className="text-fg2 m-0 text-xs leading-4.5">{title}</p>
      {action}
    </div>
  );
}

// ── Inheritance ──────────────────────────────────────────

/** Mirrors the engine's SettingsLayerName (engine/settings/schema.ts) —
 *  including `team`, the cloud layer, which this union used to omit: a
 *  team-sourced value fell through SOURCE_LABEL to `undefined` and rendered
 *  a blank provenance chip. */
export type SettingsSource =
  | "default"
  | "user"
  | "team"
  | "repo"
  | "repo-local"
  | "workspace-local"
  | "managed";

/** True when a resolved leaf came from a weaker layer than the repo —
 *  i.e. the repo is inheriting it, not setting it. (repo / repo-local /
 *  workspace-local are overrides, not inherited.) */
export function isInheritedSource(source: SettingsSource | undefined): boolean {
  return (
    source === "user" ||
    source === "default" ||
    source === "team" ||
    source === "managed"
  );
}

const SOURCE_LABEL: Record<SettingsSource, string> = {
  default: "Default",
  user: "User",
  repo: "Repo",
  "repo-local": "This Mac",
  "workspace-local": "This Workspace",
  team: "Team",
  managed: "Managed",
};

/** A small provenance tag (e.g. "User", "Default") for a resolved value. */
export function SourceTag({ source }: { source: SettingsSource | undefined }) {
  if (!source) return null;
  return (
    <span className={cn(badgeVariants({ variant: "outline" }), "select-none")}>
      {SOURCE_LABEL[source]}
    </span>
  );
}

/** A quiet group of values inherited from a weaker layer (typically User).
 *  Read-only by default; each child is a locked `InheritedRow`. Matches the
 *  "Inherited from User" pattern in the repo settings reference. */
export function InheritedGroup({
  label = "Inherited from User",
  children,
}: {
  label?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 pt-2">
      <div className={cn(NAME_CLS, "flex items-center gap-1.5 px-0.5")}>
        <Lock className="text-fg3 size-3" aria-hidden="true" />
        {label}
      </div>
      <SettingsList>{children}</SettingsList>
    </section>
  );
}

/** One inherited (read-only) entry: a name, the effective value, and an
 *  Override affordance that copies it into the repo layer for editing. */
export function InheritedRow({
  name,
  value,
  onOverride,
}: {
  name: React.ReactNode;
  value?: React.ReactNode;
  onOverride?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-fg2 text-3xxs truncate font-mono">{name}</span>
        {value != null && <span className={cn(HINT_CLS, "truncate")}>{value}</span>}
      </div>
      {onOverride && (
        <Button variant="ghost" size="compact" className="shrink-0" onClick={onOverride}>
          Override
        </Button>
      )}
    </div>
  );
}

/** A subtle "Reset" link shown next to an overridden value to drop the repo
 *  key and fall back to the inherited one. */
export function ResetToInherited({ onReset }: { onReset: () => void }) {
  return (
    <Button variant="ghost" size="compact" className="shrink-0" onClick={onReset}>
      Reset
    </Button>
  );
}
