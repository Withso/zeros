// PURPOSE: The Style panel's one hover card and one token picker. Fields stay
// plain markup: the card follows the field under the pointer (or keyboard
// focus) through one set of listeners on the panel, and says where its value
// comes from; the picker opens for whichever field asks.

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { RotateCcw } from "lucide-react";

import { isKeyboardNavigationActive } from "../../shared/ui/focus-navigation";
import { Button, Popover, PopoverAnchor, PopoverContent } from "../../shared/ui/primitives";
import { KbdKeys } from "../../shared/ui/primitives/kbd";
import { useTooltipDelay } from "../../shared/ui/primitives/tooltip";
import type { DesignFieldOrigins } from "./design-field-origins";
import { designTokenDetachHint, designTokenFieldTypes } from "./design-token-catalog";
import { designStylePropertyLabel } from "./design-style-origins";
import { useDesignTokenDetach, useDesignTokens } from "./design-token-context";
import {
  DesignFieldOverlaysContext,
  type DesignFieldOverlaysApi,
  type DesignPickerRequest,
} from "./design-field-overlays";
import { DesignTokenPicker, designFieldEdgeAnchor } from "./design-token-picker";

// Radix HoverCard's close delay: long enough to cross from the field to the
// card beside the panel.
const CARD_CLOSE_DELAY = 300;
const FIELD = "[data-design-style-property]";

/** A field's `data-design-token-companion`: `property:value` pairs separated
 * by `;`, written with any token chosen for it. */
function fieldCompanion(field: HTMLElement): Record<string, string> | undefined {
  const declared = field.getAttribute("data-design-token-companion");
  if (!declared) return undefined;
  return Object.fromEntries(
    declared.split(";").flatMap((pair) => {
      const colon = pair.indexOf(":");
      return colon > 0 ? [[pair.slice(0, colon).trim(), pair.slice(colon + 1).trim()]] : [];
    }),
  );
}

function fieldProperties(field: HTMLElement): string[] {
  const property = field.getAttribute("data-design-style-property") ?? "";
  const linked = field.getAttribute("data-design-linked-properties")?.split(" ").filter(Boolean) ?? [];
  return property ? [property, ...linked] : [];
}

/** Hover or focus is busy elsewhere: an edit, a drag or another overlay. */
function cardBlocked(root: HTMLElement, card: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    root.contains(active) &&
    (active instanceof HTMLInputElement || active.isContentEditable) &&
    !isKeyboardNavigationActive()
  )
    return true;
  for (const wrapper of document.querySelectorAll("[data-radix-popper-content-wrapper]")) {
    if (!card || !wrapper.contains(card)) return true;
  }
  return false;
}

interface CardTarget {
  field: HTMLElement;
  property: string;
  focus: HTMLElement | null;
}

export function DesignFieldOverlays({
  rootRef,
  active,
  ownerKey,
  origins,
  disabled = false,
  onChooseToken,
  onReset,
  children,
}: {
  rootRef: React.RefObject<HTMLElement | null>;
  /** The Design surface is shown; listeners attach only then. */
  active: boolean;
  /** The selection the panel shows; the card and picker close when it changes. */
  ownerKey: string;
  origins: DesignFieldOrigins;
  disabled?: boolean;
  /** `companion` is what the field itself writes beside a token (Fill clears
   * a gradient), so a token chosen here lands the same way. */
  onChooseToken: (properties: readonly string[], name: string, companion?: Record<string, string>) => void;
  onReset: (properties: readonly string[]) => void;
  children: React.ReactNode;
}) {
  const catalog = useDesignTokens();
  const delay = useTooltipDelay();
  const [card, setCard] = useState<CardTarget | null>(null);
  const [picker, setPicker] = useState<DesignPickerRequest | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const cardId = useId();
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const pickerRef = useRef(picker);
  pickerRef.current = picker;
  const cardStateRef = useRef(card);
  cardStateRef.current = card;
  // The panel's listeners stay attached across renders; they read these.
  const latest = useRef({ disabled, onReset, onChooseToken });
  latest.current = { disabled, onReset, onChooseToken };

  const clearTimers = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  const closeCard = useCallback(() => {
    clearTimers();
    setCard(null);
  }, []);

  // The card describes the focused control while it is open from keyboard.
  useEffect(() => {
    const focus = card?.focus;
    if (!focus) return;
    focus.setAttribute("aria-describedby", cardId);
    return () => focus.removeAttribute("aria-describedby");
  }, [card, cardId]);

  const closePicker = useCallback((returnFocus: boolean) => {
    const current = pickerRef.current;
    if (!current) return;
    current.trigger?.setAttribute("aria-expanded", "false");
    setPicker(null);
    if (returnFocus) {
      const target = current.trigger?.isConnected
        ? current.trigger
        : current.field.querySelector<HTMLElement>("input, [data-design-style-token]");
      requestAnimationFrame(() => target?.focus({ preventScroll: true }));
    }
  }, []);

  const api = useMemo<DesignFieldOverlaysApi>(() => {
    const openPicker = (request: DesignPickerRequest) => {
      const current = pickerRef.current;
      if (current?.field === request.field) {
        closePicker(true);
        return;
      }
      current?.trigger?.setAttribute("aria-expanded", "false");
      clearTimers();
      setCard(null);
      request.trigger?.setAttribute("aria-expanded", "true");
      setPicker(request);
    };
    const openPickerForField = (field: HTMLElement, trigger?: HTMLElement | null) => {
      const properties = fieldProperties(field);
      const accepts = properties[0] ? designTokenFieldTypes(properties[0]) : null;
      if (!accepts || !accepts.some((type) => catalog.types.has(type))) return false;
      const pill = field.querySelector<HTMLElement>("[data-design-style-token]");
      openPicker({
        field,
        label: field.getAttribute("data-design-field-label") ?? properties[0]!,
        accepts,
        activeName:
          pill && !pill.hasAttribute("data-design-token-missing")
            ? pill.getAttribute("data-design-style-token")
            : null,
        onChoose: (name) => latest.current.onChooseToken(properties, name, fieldCompanion(field)),
        trigger: trigger ?? pill,
      });
      return true;
    };
    const resetField = (element: HTMLElement) => {
      const field = element.closest<HTMLElement>(FIELD);
      clearTimers();
      setCard(null);
      if (field && !latest.current.disabled) latest.current.onReset(fieldProperties(field));
    };
    return {
      openPicker,
      openPickerForField,
      resetField,
      fieldShortcut(event) {
        const field = event.target instanceof Element ? event.target.closest<HTMLElement>(FIELD) : null;
        if (!field || !event.altKey || event.metaKey || event.ctrlKey) return;
        if (event.key === "Backspace") {
          // A text input drops its draft first and asks itself.
          if (event.target instanceof HTMLInputElement) return;
          event.preventDefault();
          event.stopPropagation();
          resetField(field);
        } else if (event.key === "ArrowDown") {
          const trigger = event.target instanceof HTMLElement ? event.target : null;
          if (
            !latest.current.disabled &&
            openPickerForField(field, trigger?.hasAttribute("aria-haspopup") ? trigger : null)
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }
      },
    };
  }, [catalog, closePicker]);

  const apiRef = useRef(api);
  apiRef.current = api;

  // A new selection or frame starts with nothing open.
  useEffect(() => {
    closeCard();
    closePicker(false);
  }, [closeCard, closePicker, ownerKey]);

  // A hidden retained surface holds no open overlay.
  useEffect(() => {
    if (!active) closePicker(false);
  }, [active, closePicker]);

  useEffect(() => {
    const root = rootRef.current;
    if (!active || !root) return;
    const fieldOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>(FIELD) : null;
    const scheduleClose = () => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      openTimer.current = null;
      if (!cardStateRef.current || closeTimer.current !== null) return;
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setCard(null);
      }, CARD_CLOSE_DELAY);
    };
    // The control a pending keyboard open is for.
    let pendingFocus: HTMLElement | null = null;
    const scheduleOpen = (field: HTMLElement, focus: HTMLElement | null) => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
      if (cardStateRef.current?.field === field) return;
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      pendingFocus = focus;
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        if (!field.isConnected || pickerRef.current || cardBlocked(root, cardRef.current)) return;
        // A scroll since may have moved the field from under the pointer, and
        // keyboard focus may have moved on.
        if (focus ? document.activeElement !== focus : !field.matches(":hover")) return;
        const property = field.getAttribute("data-design-style-property");
        if (property) setCard({ field, property, focus });
      }, delay);
    };
    const pointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const field = fieldOf(event.target);
      if (!field || event.buttons !== 0) {
        scheduleClose();
        return;
      }
      scheduleOpen(field, null);
    };
    const pointerLeave = (event: PointerEvent) => {
      // Crossing into the card keeps it; its own leave closes it.
      if (event.relatedTarget instanceof Node && cardRef.current?.contains(event.relatedTarget)) return;
      scheduleClose();
    };
    // A press starts an edit, a scrub or a drag; the card steps aside.
    const pointerDown = () => {
      clearTimers();
      setCard(null);
    };
    const focusIn = (event: FocusEvent) => {
      const field = fieldOf(event.target);
      if (!field || !isKeyboardNavigationActive()) return;
      scheduleOpen(field, event.target instanceof HTMLElement ? event.target : null);
    };
    const focusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && (fieldOf(next) || cardRef.current?.contains(next))) return;
      // Leaving the panel drops a keyboard card still waiting to open.
      if (!(next instanceof Node && root.contains(next)) && openTimer.current !== null && pendingFocus === event.target) {
        window.clearTimeout(openTimer.current);
        openTimer.current = null;
      }
      if (cardStateRef.current?.focus) {
        clearTimers();
        setCard(null);
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearTimers();
        setCard(null);
        return;
      }
      apiRef.current.fieldShortcut(event);
    };
    // The panel scrolled under an open card; a pending one checks the field
    // is still under the pointer when it opens.
    const scroll = () => {
      if (!cardStateRef.current) return;
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
      setCard(null);
    };
    root.addEventListener("pointerover", pointerOver);
    root.addEventListener("pointerleave", pointerLeave);
    root.addEventListener("pointerdown", pointerDown, true);
    root.addEventListener("focusin", focusIn);
    root.addEventListener("focusout", focusOut);
    root.addEventListener("keydown", keyDown, true);
    root.addEventListener("scroll", scroll, true);
    return () => {
      root.removeEventListener("pointerover", pointerOver);
      root.removeEventListener("pointerleave", pointerLeave);
      root.removeEventListener("pointerdown", pointerDown, true);
      root.removeEventListener("focusin", focusIn);
      root.removeEventListener("focusout", focusOut);
      root.removeEventListener("keydown", keyDown, true);
      root.removeEventListener("scroll", scroll, true);
      clearTimers();
      setCard(null);
    };
  }, [active, delay, rootRef]);

  return (
    <DesignFieldOverlaysContext.Provider value={api}>
      {children}
      {card ? (
        <DesignStyleCardContent
          ref={cardRef}
          id={cardId}
          target={card}
          panel={rootRef.current}
          origins={origins}
          catalog={catalog}
          disabled={disabled}
          onKeep={() => {
            if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
            closeTimer.current = null;
          }}
          onLeave={() => {
            if (closeTimer.current !== null) return;
            closeTimer.current = window.setTimeout(() => {
              closeTimer.current = null;
              setCard(null);
            }, CARD_CLOSE_DELAY);
          }}
          onClose={closeCard}
          onReset={() => {
            closeCard();
            onReset(fieldProperties(card.field));
          }}
          onUseToken={() => {
            closeCard();
            api.openPickerForField(card.field);
          }}
        />
      ) : null}
      {picker ? (
        <DesignTokenPicker
          label={picker.label}
          accepts={picker.accepts}
          rows={picker.rows}
          kind={picker.kind}
          activeName={picker.activeName}
          disabled={disabled}
          open
          anchor={picker.field}
          panel={rootRef.current}
          trigger={{ current: picker.trigger ?? null }}
          onOpenChange={(open) => {
            if (!open) closePicker(true);
          }}
          onChoose={(name) => picker.onChoose(name)}
        />
      ) : null}
    </DesignFieldOverlaysContext.Provider>
  );
}

const DesignStyleCardContent = React.forwardRef<
  HTMLDivElement,
  {
    id: string;
    target: CardTarget;
    panel: HTMLElement | null;
    origins: DesignFieldOrigins;
    catalog: ReturnType<typeof useDesignTokens>;
    disabled: boolean;
    onKeep: () => void;
    onLeave: () => void;
    onClose: () => void;
    onReset: () => void;
    onUseToken: () => void;
  }
>(function DesignStyleCardContent(
  { id, target, panel, origins, catalog, disabled, onKeep, onLeave, onClose, onReset, onUseToken },
  ref,
) {
  const { field, property } = target;
  const edge = useMemo(() => designFieldEdgeAnchor(field, panel), [field, panel]);
  const content = designStyleCardContent(readDesignCardField(field, property), origins, catalog);
  const detach = useDesignTokenDetach();
  const actions = detach ? content.actions : content.actions.filter((action) => action.kind !== "detach");
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={edge} />
      <PopoverContent
        ref={ref}
        id={id}
        role="dialog"
        aria-label={`Where ${content.label} comes from`}
        data-design-style-card=""
        side="left"
        align="start"
        sideOffset={8}
        padding="none"
        className="w-72"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onPointerEnter={onKeep}
        onPointerLeave={onLeave}
      >
        <div className="flex flex-col gap-2 px-3 py-2.5 text-3xxs leading-4.5">
          <p className="text-fg1 text-xs font-medium">{content.label}</p>
          {content.rows.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {content.rows.map((row) => (
                <p key={`${row.key}:${row.text}`} className="text-fg2 flex gap-2">
                  <span className="text-fg3 w-13 shrink-0">{row.key}</span>
                  <span className="min-w-0 break-words">{row.text}</span>
                </p>
              ))}
            </div>
          ) : null}
          {content.notes.map((note) => (
            <p key={note} className="text-fg2">
              {note}
            </p>
          ))}
          {content.foot || actions.length > 0 ? (
            <div className="border-border2 text-fg2 flex flex-col gap-2 border-t pt-2">
              {content.foot ? <span className="min-w-0">{content.foot}</span> : null}
              {/* Wraps rather than overflow when labels grow. */}
              {actions.length > 0 ? (
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  {actions.map((action) => (
                    <Button
                      key={action.kind}
                      type="button"
                      variant="secondary"
                      size="compact"
                      disabled={disabled}
                      data-design-card-action={action.kind}
                      aria-keyshortcuts={action.shortcut}
                      onClick={() => {
                        if (action.kind === "reset") onReset();
                        else if (action.kind === "token" || action.kind === "pick") onUseToken();
                        else {
                          onClose();
                          // The field's own Detach does the same: each selected
                          // layer's resolved value over the token.
                          detach?.(fieldProperties(field));
                        }
                      }}
                    >
                      {action.kind === "reset" ? <RotateCcw aria-hidden="true" /> : null}
                      {action.label}
                      {action.keys ? <KbdKeys keys={action.keys} aria-hidden="true" /> : null}
                    </Button>
                  ))}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
});

export interface DesignStyleCardText {
  label: string;
  rows: { key: string; text: string }[];
  notes: string[];
  foot?: string;
  actions: { kind: "reset" | "token" | "pick" | "detach"; label: string; keys?: string; shortcut?: string }[];
}

/** What a field shows that the card speaks to, read from its markup. */
export interface DesignCardField {
  property: string;
  label: string;
  mixed: boolean;
  tokenName: string | null;
  missing: boolean;
}

/** The name a person sees for a field: its group's label when the two name
 * the same thing (Corner radius for Radius, Color for Text color), the
 * field's label with its group's otherwise (Horizontal padding), and a
 * property's name for a one-letter label (Width for W). */
export function designFieldTitle({
  property,
  label,
  groupLabel,
  groupFields,
}: {
  property: string;
  label: string;
  groupLabel: string | null;
  groupFields: number;
}): string {
  if (label.length <= 2) return designStylePropertyLabel(property);
  if (!groupLabel) return label;
  const group = groupLabel.toLowerCase();
  const own = label.toLowerCase();
  if (group.includes(own) || own.includes(group)) return groupLabel;
  return groupFields > 1 ? `${label} ${groupLabel.toLowerCase()}` : label;
}

export function readDesignCardField(field: HTMLElement, property: string): DesignCardField {
  const input = field.querySelector("input");
  const pill = field.querySelector<HTMLElement>("[data-design-style-token]");
  const group = field.closest(".zd-group");
  return {
    property,
    label: designFieldTitle({
      property,
      label: field.getAttribute("data-design-field-label") ?? property,
      groupLabel: group?.querySelector(".zd-group-label")?.textContent?.trim() || null,
      groupFields: group?.querySelectorAll(FIELD).length ?? 0,
    }),
    mixed: input?.placeholder === "Mixed" && input.value === "",
    tokenName: pill?.getAttribute("data-design-style-token") ?? null,
    missing: Boolean(pill?.hasAttribute("data-design-token-missing")),
  };
}

/** What the card says about one field: the origin model's strings, plus what
 * the field itself shows (a pill, a missing token, Mixed). */
export function designStyleCardContent(
  { property, label, mixed, tokenName, missing }: DesignCardField,
  origins: DesignFieldOrigins,
  catalog: ReturnType<typeof useDesignTokens>,
): DesignStyleCardText {
  if (mixed) {
    return { label, rows: [{ key: "Value", text: "Mixed: the selected layers differ" }], notes: [], actions: [] };
  }
  const origin = origins.origin(property);
  const rows = [...(origin?.card.rows ?? [])];
  const notes: string[] = [];
  const actions: DesignStyleCardText["actions"] = [];
  const accepts = designTokenFieldTypes(property);
  const offered = Boolean(accepts?.some((type) => catalog.types.has(type)));
  if (tokenName && missing) {
    const name = tokenName.replace(/^--/, "");
    if (rows[0]?.key === "Value") rows[0] = { key: "Value", text: `${name} is missing; the field keeps its last value` };
    if (offered) actions.push({ kind: "pick", label: "Pick another", keys: "⌥↓", shortcut: "Alt+ArrowDown" });
    actions.push({ kind: "detach", label: "Detach" });
  } else if (tokenName) {
    const hint = designTokenDetachHint(catalog.byName.get(tokenName), catalog.themeLabel);
    if (hint) notes.push(hint);
  }
  if (origin?.card.forcedBy) notes.push(`Forced by ${origin.card.forcedBy}`);
  const reset = origin?.card.reset;
  if (reset) {
    if (reset.text !== "Reset") notes.push(reset.text);
    actions.unshift({ kind: "reset", label: "Reset", keys: "⌥⌫", shortcut: "Alt+Backspace" });
  }
  if (!tokenName && offered && origin?.kind !== "forced") {
    actions.push({ kind: "token", label: "Use a token", keys: "⌥↓", shortcut: "Alt+ArrowDown" });
  }
  return { label, rows, notes, foot: origin?.card.foot, actions };
}
