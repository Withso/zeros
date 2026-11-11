// PURPOSE: Design tokens in the Style panel: the pill a field shows when a
// token sets its value, the Detach action beside it, and the picker that
// offers only the tokens of the field's own type, grouped by role.

import React, { useMemo, useState } from "react";
import { Check, Unlink } from "lucide-react";

import { cn } from "../../shared/ui/cn";
import {
  Button,
  IconButton,
  Input,
  Pill,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../../shared/ui/primitives";
import { DesignColorSwatch } from "./design-color-swatch";
import {
  focusDesignPopoverSurface,
  InspectorPopoverAnchor,
} from "./design-inspector-kit";
import {
  designTokenDetachHint,
  designTokenGroups,
  designTokenKindLabel,
  designTokenSummary,
  type DesignTokenGroup,
  type DesignTokenType,
} from "./design-token-catalog";
import { useDesignTokens } from "./design-token-context";

/** A token reference as a Style field shows it. */
export interface DesignFieldToken {
  /** Custom property name, with its leading dashes. */
  name: string;
  /** The frame no longer declares it. */
  missing: boolean;
}

/** The pill a field shows in place of its value. It takes the value's Tab
 * stop; a printable key typed on it starts a plain value instead. A pill
 * that opens a picker says so with `aria-haspopup` and `aria-expanded`. */
export const DesignTokenPill = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof Pill> & {
    label: string;
    token: DesignFieldToken;
    onType?: (key: string) => void;
  }
>(function DesignTokenPill({ label, token, onType, onKeyDown, className, ...props }, ref) {
  const name = token.name.replace(/^--/, "");
  // Its source and value are on the panel's hover card.
  return (
    <Pill
      ref={ref}
      tone={token.missing ? "missing" : "token"}
      aria-label={
        token.missing ? `${label}: missing token ${name}` : `${label}: token ${name}`
      }
      data-design-style-token={token.name}
      data-design-token-missing={token.missing ? "" : undefined}
      className={cn("min-w-0 max-w-full", className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || !onType) return;
        if (
          event.key.length === 1 &&
          event.key !== " " &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          onType(event.key);
        }
      }}
      {...props}
    >
      {/* A missing token's name truncates first; "is missing" gives way only
          once the name is gone (a field too narrow for both). */}
      <span className={token.missing ? "shrink-[1000]" : undefined}>{name}</span>
      {token.missing ? <span>{"\u00a0is missing"}</span> : null}
    </Pill>
  );
});

export { designTokenDetachHint };

/** Detach, at the end of a field holding a token. Its `.zd-field-token-detach`
 * wrapper shows it on hover and focus within the field, always for a missing
 * token; what a theme-dependent token loses is on the panel's hover card. */
export function DesignTokenDetachButton({
  disabled,
  onDetach,
}: {
  disabled?: boolean;
  onDetach: () => void;
}) {
  return (
    <IconButton
      size="inline"
      label="Detach token"
      disabled={disabled}
      data-design-token-detach=""
      className="mr-0.5"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onDetach}
    >
      <Unlink />
    </IconButton>
  );
}

const SEARCH_LABEL: Record<string, string> = {
  color: "Search color tokens",
  size: "Search size tokens",
  number: "Search number tokens",
  weight: "Search weight tokens",
  font: "Search font tokens",
  text: "Search text styles",
};

export interface DesignTokenListRow {
  name: string;
  summary: string;
  /** A colour for the swatch, or "text" for a text style's Aa. */
  glyph?: { color: string } | "text";
}

export interface DesignTokenListGroup {
  key: string;
  label: string;
  rows: readonly DesignTokenListRow[];
}

/** The picker's search, role groups and rows. Arrow keys move between rows,
 * a letter typed on a row searches, and Escape clears a search before it
 * closes the picker. */
export function DesignTokenRows({
  groups,
  kind,
  activeName,
  query,
  disabled = false,
  footer = true,
  onQueryChange,
  onChoose,
}: {
  groups: readonly DesignTokenListGroup[];
  /** "color", "size", "text"…: what the footer and empty state name. */
  kind: string;
  activeName: string | null;
  query: string;
  disabled?: boolean;
  footer?: boolean;
  onQueryChange: (query: string) => void;
  onChoose: (name: string) => void;
}) {
  const searchRef = React.useRef<HTMLInputElement | null>(null);
  const shown = filterDesignTokenListGroups(groups, query);
  const noun = kind === "text" ? "text styles" : `${kind} tokens`;
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const onRow = target.matches("[data-design-token-option]");
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      onQueryChange("");
      searchRef.current?.focus();
      return;
    }
    if (onRow && event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      onQueryChange(query + event.key);
      searchRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[data-design-token-option]:not(:disabled)",
      ),
    ];
    if (options.length === 0) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next =
      index < 0
        ? step > 0
          ? 0
          : options.length - 1
        : Math.min(options.length - 1, Math.max(0, index + step));
    options[next]?.focus();
  };
  return (
    <div className="flex min-w-0 flex-col gap-2" onKeyDown={onKeyDown}>
      <Input
        ref={searchRef}
        type="search"
        value={query}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        placeholder={kind === "text" ? "Search text styles" : "Search tokens"}
        aria-label={SEARCH_LABEL[kind] ?? "Search tokens"}
        // An empty search holds no typing of its own, so Command-Z there
        // undoes the design, as it does on a row.
        data-design-draft={query ? "dirty" : "clean"}
        className="text-xs"
        onChange={(event) => onQueryChange(event.currentTarget.value)}
      />
      <div
        data-design-token-rows=""
        className="-mx-1 flex max-h-72 min-w-0 flex-col gap-1 overflow-y-auto px-1"
      >
        {shown.length === 0 ? (
          <p className="text-fg3 px-1 py-2 text-xs" data-design-token-empty="">
            {groups.length === 0 ? `No ${noun} in this directory.` : `No ${noun} match.`}
          </p>
        ) : (
          shown.map((group) => (
            <div key={group.key} role="group" aria-label={group.label} className="flex min-w-0 flex-col">
              <div className="text-fg3 truncate px-1.5 pt-1 pb-0.5 text-2xxs font-medium">
                {group.label}
              </div>
              {group.rows.map((row) => {
                const active = row.name === activeName;
                return (
                  <Button
                    key={row.name}
                    type="button"
                    variant="ghost"
                    disabled={disabled}
                    aria-pressed={active}
                    data-design-token-option={row.name}
                    data-design-color-token={row.glyph && row.glyph !== "text" ? row.name : undefined}
                    className="text-fg2 aria-pressed:bg-bg2-highlight h-auto min-h-10 w-full justify-start gap-2.5 py-1 font-normal"
                    onClick={() => onChoose(row.name)}
                  >
                    {row.glyph === "text" ? (
                      <span aria-hidden="true" className="text-fg2 w-4.5 shrink-0 text-center text-xs font-medium">
                        Aa
                      </span>
                    ) : row.glyph ? (
                      <DesignColorSwatch value={row.glyph.color} className="size-4.5" />
                    ) : null}
                    <span className="flex min-w-0 flex-1 flex-col text-left">
                      <span className="text-fg1 truncate text-xs">{row.name.replace(/^--/, "")}</span>
                      <span className="text-fg3 truncate text-3xxs">{row.summary}</span>
                    </span>
                    {active ? <Check className="text-fg1 size-3.5" aria-hidden="true" /> : null}
                  </Button>
                );
              })}
            </div>
          ))
        )}
      </div>
      {footer ? (
        <p className="text-fg3 border-border2 -mx-3 -mb-3 border-t px-3.5 py-2 text-3xxs" data-design-token-footer="">
          {kind === "text"
            ? "A text field lists text styles only."
            : `A ${kind} field lists ${kind} tokens only.`}
        </p>
      ) : null}
    </div>
  );
}

/** Groups whose label, or whose rows' names or summaries (a token's
 * description or value), contain the query. An empty query returns them all. */
export function filterDesignTokenListGroups(
  groups: readonly DesignTokenListGroup[],
  query: string,
): readonly DesignTokenListGroup[] {
  const needle = query.trim().toLocaleLowerCase().replace(/^--/, "");
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      rows: group.label.toLocaleLowerCase().includes(needle)
        ? group.rows
        : group.rows.filter((row) =>
            [row.name, row.summary].some((text) => text.toLocaleLowerCase().includes(needle)),
          ),
    }))
    .filter((group) => group.rows.length > 0);
}

/** Picker rows for catalog groups: a swatch for colours, the summary under
 * each name. */
export function designTokenListGroups(groups: readonly DesignTokenGroup[]): DesignTokenListGroup[] {
  return groups.map((group) => ({
    key: group.key,
    label: group.label,
    rows: group.tokens.map((token) => ({
      name: token.name,
      summary: designTokenSummary(token),
      ...(token.types.includes("color") && token.resolved ? { glyph: { color: token.resolved } } : {}),
    })),
  }));
}

/** Where the panel's popovers attach for a field: level with the field,
 * at the panel's own left edge so nothing covers the panel's other fields;
 * without a panel, 12px left of the field, as InspectorPopoverAnchor marks. */
export function designFieldEdgeAnchor(
  element: HTMLElement,
  panel?: HTMLElement | null,
): React.RefObject<{ getBoundingClientRect: () => DOMRect }> {
  return {
    current: {
      getBoundingClientRect: () => {
        const rect = element.getBoundingClientRect();
        const left = panel ? panel.getBoundingClientRect().left : rect.left - 12;
        return new DOMRect(left, rect.top, 0, rect.height);
      },
    },
  };
}

/** The token picker for one field: the tokens of its own type, by role.
 * The caller renders it only while open, beside the field's pill or input,
 * so a closed picker mounts nothing. */
export function DesignTokenPicker({
  label,
  accepts,
  rows,
  kind,
  activeName,
  disabled,
  open,
  onOpenChange,
  onChoose,
  trigger,
  anchor,
  panel,
}: {
  label: string;
  accepts: readonly DesignTokenType[];
  /** Rows prepared by the caller, such as text styles, in place of the
   * catalog's tokens of `accepts`. */
  rows?: readonly DesignTokenListGroup[];
  /** What the footer and empty state name; derived from `accepts`. */
  kind?: string;
  activeName: string | null;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (name: string) => void;
  /** The control that opened it, such as the pill: a press on it closes the
   * picker rather than reopening it, and focus returns to it on close. */
  trigger?: React.RefObject<HTMLElement | null>;
  /** The field it belongs to, when the panel's one picker opens for it. */
  anchor?: HTMLElement | null;
  /** The panel the picker opens beside. */
  panel?: HTMLElement | null;
}) {
  const [query, setQuery] = useState("");
  const edge = useMemo(() => (anchor ? designFieldEdgeAnchor(anchor, panel) : null), [anchor, panel]);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      {edge ? <PopoverAnchor virtualRef={edge} /> : <InspectorPopoverAnchor />}
      <PopoverContent
        data-design-popover=""
        data-design-token-picker=""
        aria-label={`${label} token`}
        onOpenAutoFocus={focusDesignPopoverSurface}
        onInteractOutside={(event) => {
          // The trigger's own click toggles the picker closed.
          if (event.target instanceof Node && trigger?.current?.contains(event.target)) {
            event.preventDefault();
          }
        }}
        onCloseAutoFocus={(event) => {
          const target = trigger?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => {
          // A search is cleared before the picker closes.
          if (!query) return;
          event.preventDefault();
          setQuery("");
        }}
        side="left"
        align="start"
        sideOffset={8}
        padding="none"
        size="md"
      >
        <div className="zd-popover">
          <div className="zd-popover-header">
            <span className="zd-popover-title">{label}</span>
          </div>
          <DesignTokenPickerRows
            accepts={accepts}
            rows={rows}
            kind={kind ?? designTokenKindLabel(accepts)}
            activeName={activeName}
            query={query}
            disabled={disabled}
            onQueryChange={setQuery}
            onChoose={(name) => {
              onChoose(name);
              onOpenChange(false);
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The picker's list, grouped only while the picker is open. */
function DesignTokenPickerRows({
  accepts,
  rows,
  ...props
}: Omit<React.ComponentProps<typeof DesignTokenRows>, "groups"> & {
  accepts: readonly DesignTokenType[];
  rows?: readonly DesignTokenListGroup[];
}) {
  const catalog = useDesignTokens();
  const groups = useMemo(
    () => rows ?? designTokenListGroups(designTokenGroups(catalog, accepts)),
    [accepts, catalog, rows],
  );
  return <DesignTokenRows groups={groups} {...props} />;
}

/** Whether the catalog has any token a field of these types can take. */
export function useDesignTokensFor(accepts: readonly DesignTokenType[] | null): boolean {
  const { types } = useDesignTokens();
  return !!accepts && accepts.some((type) => types.has(type));
}
