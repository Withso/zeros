// ──────────────────────────────────────────────────────────
// Settings UI primitives — flat sections, no cards
// ──────────────────────────────────────────────────────────
//
// The shared visual vocabulary for every settings panel (User + Repo).
// The former `rounded-lg border bg-bg3 p-6` card that wrapped every group was
// retired; the page reads as flat sections of
// label-left / control-right rows separated by hairline dividers, with
// inputs and selects keeping their own borders and nothing else boxed.
//
// Build these ONCE; every panel composes them so User and Repo scopes
// read identically.
//
// Zeros Foundation (styles/zeros-foundation.md): section heading /
// row label `font-medium text-fg1`; hints `text-xs text-fg2`; dividers
// `border-border1`; default text fg2, focal/selected fg1; 4 px grid.
//
// NAMES (section titles + row/field/empty labels) size as `text-[14px]`,
// NOT `text-sm`: names are 14px and everything
// else 13px on the settings page. The arbitrary `text-[14px]` is load-
// bearing: it opts these out of the `.settings-type-scale` shrink that
// pulls `.text-sm` controls down to 13px (settings-page.css). It equals the
// old `text-sm` (14px) everywhere else (e.g. repo settings), so no other
// surface changes. Hints stay `text-xs` = the app-native 13px.
// ──────────────────────────────────────────────────────────

import React from "react";
import { Lock } from "lucide-react";
import { cn } from "@/renderer/shared/ui/cn";

// ── Section ──────────────────────────────────────────────

/** A flat settings section: a muted heading (with an optional one-line
 *  description and a right-aligned action), then its body. No card. */
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
    <section className={cn("flex flex-col gap-3", className)}>
      {(title || action || description) && (
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && (
              <h2 className="text-fg1 m-0 text-[14px] font-medium">{title}</h2>
            )}
            {description && <p className="text-fg2 text-xs">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Filled section card for settings rows — the Models-panel recipe (a
 *  borderless subtle-fill card, `--border1` hairlines between rows, 12px
 *  padding on all sides via `px-3` + the `[&>*]:py-3` row override). The
 *  fill is `--bg1-highlight`, NOT `--bg3`: in light mode bg3 = bg1 = white
 *  and the card would vanish (check:ui guards this). Pass as `className`
 *  to a `SettingsList`. */
export const SETTINGS_CARD_LIST_CLS =
  "bg-bg1-highlight divide-border1 rounded-lg px-3 [&>*]:py-3";

/** A flat row group: `SettingsRow` / `SettingsField` children separated by
 *  hairline dividers, sitting directly on the page surface — no card fill,
 *  no border, no rounding (the bg2 card was retired 2026-07-12; rows align
 *  flush with the section headings). */
export function SettingsList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("divide-border2 flex flex-col divide-y", className)}>
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
  children,
  className,
  align = "center",
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  children?: React.ReactNode;
  className?: string;
  /** Vertical alignment of the control against the label block. */
  align?: "center" | "start";
}) {
  return (
    <div
      className={cn(
        "flex justify-between gap-4 py-3.5",
        align === "center" ? "items-center" : "items-start",
        className,
      )}
    >
      {(label || hint) && (
        <div className="flex min-w-0 flex-col gap-0.5">
          {label &&
            (htmlFor ? (
              <label
                htmlFor={htmlFor}
                className="text-fg1 text-[14px] font-medium"
              >
                {label}
              </label>
            ) : (
              <span className="text-fg1 text-[14px] font-medium">{label}</span>
            ))}
          {hint && (
            <span className="text-fg2 text-xs leading-relaxed">{hint}</span>
          )}
        </div>
      )}
      {children != null && <div className="shrink-0">{children}</div>}
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
    <div className={cn("flex flex-col gap-2 py-3.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-fg1 text-[14px] font-medium">
          {label}
        </label>
      )}
      {children}
      {hint && <p className="text-fg2 text-xs leading-relaxed">{hint}</p>}
    </div>
  );
}

/** A right-aligned Save row to close a section. */
export function SettingsActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 pt-1">{children}</div>
  );
}

/** Empty-state block for a section with nothing configured yet. */
export function SettingsEmpty({
  title,
  hint,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 py-6 text-center">
      <p className="text-fg1 text-[14px] font-medium">{title}</p>
      {hint && <p className="text-fg2 text-xs">{hint}</p>}
    </div>
  );
}

/** A compact empty collection state with its primary creation action. */
export function SettingsEmptyCard({
  title,
  action,
}: {
  title: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="border-border1 flex h-36 flex-col items-center justify-center gap-2 rounded-lg border">
      <p className="text-fg2 text-xs">{title}</p>
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
    <span className="border-border1 text-fg2 rounded-sm border px-1.5 py-px text-xs font-medium select-none">
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
      <div className="text-fg2 flex items-center gap-1.5 text-xs font-medium">
        <Lock className="size-3" aria-hidden="true" />
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
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-fg2 truncate font-mono text-sm">{name}</span>
        {value != null && (
          <span className="text-fg3 truncate text-xs">{value}</span>
        )}
      </div>
      {onOverride && (
        <button
          type="button"
          onClick={onOverride}
          className="text-fg2 hover:text-fg1 shrink-0 text-xs font-medium transition-colors"
        >
          Override
        </button>
      )}
    </div>
  );
}

/** A subtle "Reset" link shown next to an overridden value to drop the repo
 *  key and fall back to the inherited one. */
export function ResetToInherited({ onReset }: { onReset: () => void }) {
  return (
    <button
      type="button"
      onClick={onReset}
      className="text-fg2 hover:text-fg1 shrink-0 text-xs font-medium transition-colors"
    >
      Reset
    </button>
  );
}
