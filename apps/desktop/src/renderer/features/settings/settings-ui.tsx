
import React from "react";
import { Cloud, Laptop, Lock, Plus } from "lucide-react";
import { cn } from "@/renderer/shared/ui/cn";
import { badgeVariants } from "@/renderer/shared/ui/primitives/badge";
import { Button } from "@/renderer/shared/ui/primitives/button";

const NAME_CLS = "text-fg1 text-xs leading-4.5 font-medium";
const HINT_CLS = "text-fg3 text-3xxs leading-4";
const PAGE_SECTION_NAME_CLS = "text-fg1 text-sm leading-5 font-medium";

/** Inside a page section, section titles are one level down, and a title that
 * only repeats the page section's is left out. */
const PageSectionContext = React.createContext<string | null>(null);

function useSectionTitle(title: React.ReactNode): React.ReactNode {
  const pageSection = React.useContext(PageSectionContext);
  if (!title) return null;
  if (pageSection === null) return <h2 className={cn(NAME_CLS, "m-0")}>{title}</h2>;
  if (typeof title === "string" && title.trim().toLowerCase() === pageSection.toLowerCase()) return null;
  return <h3 className={cn(NAME_CLS, "m-0")}>{title}</h3>;
}

/** A long settings page's top level: one heading per section, larger than the
 * groups and sections it contains. */
export function SettingsPageSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5 px-0.5">
        <h2 className={cn(PAGE_SECTION_NAME_CLS, "m-0")}>{title}</h2>
        {description && <p className={cn(HINT_CLS, "m-0")}>{description}</p>}
      </div>
      <PageSectionContext.Provider value={title}>
        <div className="flex flex-col gap-6">{children}</div>
      </PageSectionContext.Provider>
    </section>
  );
}


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
  const heading = useSectionTitle(title);
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {(heading || action || description) && (
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            {heading}
            {description && <p className={cn(HINT_CLS, "m-0")}>{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Titles the part of a page that applies on this Mac or in cloud workspaces. */
export function PlaceLabel({ place }: { place: "mac" | "cloud" }) {
  const Icon = place === "mac" ? Laptop : Cloud;
  return (
    <span className="text-fg2 inline-flex items-center gap-1.5">
      <Icon className="text-fg3 size-3.5" strokeWidth={1.5} aria-hidden />
      {place === "mac" ? "This Mac" : "Cloud"}
    </span>
  );
}

// Use bg1-bright: bg3 matches the page background in light mode.
export const SETTINGS_CARD_LIST_CLS =
  "bg-bg1-bright border-border1 divide-border1 rounded-[calc(var(--radius-lg)*1.5)] border px-3.5 [&>*]:py-3";

// Derive this radius from --radius-lg: our token reset removes rounded-xl.
export const SETTINGS_GROUP_RADIUS = "rounded-[calc(var(--radius-lg)*1.5)]";

export function SettingsGroup({
  title,
  description,
  children,
  className,
  "aria-label": ariaLabel,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  const heading = useSectionTitle(title);
  return (
    <section aria-label={ariaLabel} className={cn("flex flex-col gap-2", className)}>
      {(heading || description) && (
        <div className="flex flex-col gap-0.5 px-0.5">
          {heading}
          {description && <p className={cn(HINT_CLS, "m-0")}>{description}</p>}
        </div>
      )}
      <SettingsList>{children}</SettingsList>
    </section>
  );
}

export function SettingsList({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  children: React.ReactNode;
}) {
  return (
    <div {...props} className={cn("flex flex-col divide-y", SETTINGS_CARD_LIST_CLS, className)}>
      {children}
    </div>
  );
}


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
  leading?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
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

export function SettingsActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 pt-1">{children}</div>
  );
}

// Make the whole card row the add target, not just its label.
export function SettingsAddRow({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      className="text-fg2 [&_svg]:text-fg3 w-full justify-start gap-2 px-0 hover:bg-transparent"
      onClick={onClick}
      disabled={disabled}
    >
      <Plus aria-hidden />
      {label}
    </Button>
  );
}

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


// Keep this provenance union in sync with SettingsLayerName in engine/settings/schema.ts.
export type SettingsSource =
  | "default"
  | "user"
  | "team"
  | "repo"
  | "repo-local"
  | "workspace-local"
  | "managed";

// Inherited means outside the repo override, not lower precedence: managed policy can win.
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

export function SourceTag({ source }: { source: SettingsSource | undefined }) {
  if (!source) return null;
  return (
    <span className={cn(badgeVariants({ variant: "outline" }), "select-none")}>
      {SOURCE_LABEL[source]}
    </span>
  );
}

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

export function ResetToInherited({ onReset }: { onReset: () => void }) {
  return (
    <Button variant="ghost" size="compact" className="shrink-0" onClick={onReset}>
      Reset
    </Button>
  );
}
