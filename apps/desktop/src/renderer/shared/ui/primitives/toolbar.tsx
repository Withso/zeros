import * as React from "react";

import { cn } from "@/renderer/shared/ui/cn";
import { IconButtonSizeContext } from "./icon-button";

// One size for every toolbar and island: 28px tools in a 36px bar. The 3px
// inset plus the 1px border puts the 6px tool corners on the bar's 10px ones.
export const TOOLBAR_INSET = "p-[calc(var(--spacing)*0.75)]";
export const TOOLBAR_RADIUS = "rounded-[calc(var(--radius-md)+var(--spacing))]";
export const TOOLBAR_SURFACE = cn(
  "border-border2 bg-bg2 text-fg2 inline-flex shrink-0 items-center gap-0.5 border",
  TOOLBAR_INSET,
  TOOLBAR_RADIUS,
);

const ITEM_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
].join(",");

/** The toolbar's own controls, not those of a nested toolbar. */
function toolbarControls(toolbar: HTMLElement): HTMLElement[] {
  return Array.from(toolbar.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(
    (item) => item.closest('[role="toolbar"]') === toolbar,
  );
}

/** The controls arrow keys can reach. */
export function toolbarItems(toolbar: HTMLElement): HTMLElement[] {
  return toolbarControls(toolbar).filter(
    (item) =>
      !item.matches(":disabled") && !item.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}

/** One Tab stop: the focused item, else the last one used, else the active
 * tool, else the first. Unreachable controls stay out of the Tab order too, so
 * one that becomes enabled never adds a second stop. */
function syncTabStops(toolbar: HTMLElement, lastUsed: HTMLElement | null) {
  const items = toolbarItems(toolbar);
  const active = toolbar.ownerDocument.activeElement;
  const current =
    items.find((item) => item === active || item.contains(active)) ??
    (lastUsed && items.includes(lastUsed) ? lastUsed : undefined) ??
    items.find((item) => item.getAttribute("aria-pressed") === "true") ??
    items[0];
  for (const control of toolbarControls(toolbar)) {
    const stop = control === current ? 0 : -1;
    if (control.tabIndex !== stop) control.tabIndex = stop;
  }
}

function isTextEntry(target: HTMLElement) {
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "reset", "submit", "image", "color"].includes(target.type);
}

export interface ToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** floating lifts the bar off the content with the dropdown shadow; docked
   * sits in a row with no shadow. */
  elevation?: "floating" | "docked";
  orientation?: "horizontal" | "vertical";
}

/** A group of tools with one Tab stop: arrow keys move between them, Home and
 * End go to the ends. */
const Toolbar = React.forwardRef<HTMLDivElement, ToolbarProps>(
  (
    {
      className,
      role = "toolbar",
      elevation = "floating",
      orientation: orientationProp,
      onKeyDown,
      onFocus,
      ...props
    },
    forwardedRef,
  ) => {
    const orientation =
      orientationProp ??
      (props["aria-orientation"] === "vertical" ? "vertical" : "horizontal");
    const node = React.useRef<HTMLDivElement | null>(null);
    const lastUsed = React.useRef<HTMLElement | null>(null);
    const roving = role === "toolbar";

    const setRef = React.useCallback(
      (element: HTMLDivElement | null) => {
        node.current = element;
        if (typeof forwardedRef === "function") forwardedRef(element);
        else if (forwardedRef) forwardedRef.current = element;
      },
      [forwardedRef],
    );

    React.useLayoutEffect(() => {
      if (roving && node.current) syncTabStops(node.current, lastUsed.current);
    });

    React.useEffect(() => {
      const toolbar = node.current;
      if (!roving || !toolbar) return;
      // A tool that turns disabled, appears or becomes active outside this
      // component's render still has to leave exactly one Tab stop.
      const observer = new MutationObserver(() => syncTabStops(toolbar, lastUsed.current));
      observer.observe(toolbar, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["disabled", "aria-pressed", "hidden", "inert", "aria-hidden"],
      });
      return () => observer.disconnect();
    }, [roving]);

    const handleFocus = (event: React.FocusEvent<HTMLDivElement>) => {
      onFocus?.(event);
      const toolbar = node.current;
      if (!roving || !toolbar) return;
      const item = toolbarItems(toolbar).find(
        (candidate) => candidate === event.target || candidate.contains(event.target),
      );
      if (!item) return;
      lastUsed.current = item;
      syncTabStops(toolbar, item);
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      const toolbar = node.current;
      if (!roving || !toolbar || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement;
      if (isTextEntry(target)) return;
      const items = toolbarItems(toolbar);
      const index = items.findIndex((item) => item === target || item.contains(target));
      if (index < 0) return;
      const previous = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
      const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
      const destination =
        event.key === next
          ? (index + 1) % items.length
          : event.key === previous
            ? (index - 1 + items.length) % items.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : -1;
      if (destination < 0) return;
      // The key is consumed here, so a canvas below does not also nudge.
      event.preventDefault();
      event.stopPropagation();
      items[destination]!.focus();
    };

    return (
      <IconButtonSizeContext.Provider value="standard">
        <div
          ref={setRef}
          role={role}
          aria-orientation={roving ? orientation : props["aria-orientation"]}
          data-orientation={orientation}
          data-elevation={elevation}
          className={cn(
            TOOLBAR_SURFACE,
            orientation === "vertical" && "flex-col",
            elevation === "floating" && "shadow-[var(--shadow-dropdown)]",
            className,
          )}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          {...props}
        />
      </IconButtonSizeContext.Provider>
    );
  },
);
Toolbar.displayName = "Toolbar";

/** A 1 × 16 border2 rule between tool groups (16 × 1 in a vertical bar). */
function ToolbarSeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="separator"
      aria-hidden
      className={cn(
        "bg-border2 shrink-0",
        "in-data-[orientation=horizontal]:mx-0.5 in-data-[orientation=horizontal]:h-4 in-data-[orientation=horizontal]:w-px",
        "in-data-[orientation=vertical]:my-0.5 in-data-[orientation=vertical]:h-px in-data-[orientation=vertical]:w-4",
        className,
      )}
      {...props}
    />
  );
}

/** Words inside a bar, such as an agent's name and what it is doing: 13/18
 * fg2 with a medium fg1 <strong>, and 14px fg3 icons. */
function ToolbarText({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "text-fg2 inline-flex min-w-0 items-center gap-1.5 px-1.5 text-xs leading-4.5 whitespace-nowrap",
        "[&_strong]:text-fg1 [&_strong]:shrink-0 [&_strong]:font-medium",
        "[&_svg]:text-fg3 [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export { Toolbar, ToolbarSeparator, ToolbarText };
