// PURPOSE: The Style panel's view-only layer states: the State menu in the
// selection header, the note under it while a state is held, and the rule
// that keeps every field read-only meanwhile. The canvas shows the state;
// nothing here writes source.

import { useEffect, useState, type RefObject } from "react";
import { ChevronDown } from "lucide-react";

import type { DesignRuntimeNodeState } from "@zeros/protocol/design-runtime";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives";
import { designStateLabel } from "./design-style-origins";

const DEFAULT = "default";

/** The header's State button and its menu: Default, then the states the
 * layer offers, in that order. Picking never waits for the frame. */
export function DesignLayerStateMenu({
  states,
  held,
  active,
  disabled = false,
  onPick,
}: {
  states: readonly DesignRuntimeNodeState[];
  held: DesignRuntimeNodeState | null;
  /** The surface is shown; a hidden one keeps no menu open. */
  active: boolean;
  disabled?: boolean;
  onPick: (state: DesignRuntimeNodeState | null) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return (
    <DropdownMenu open={open && active} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="compact"
          aria-label="Layer state"
          data-design-state-control=""
          data-design-state-button=""
          disabled={disabled || !active}
        >
          {held ? designStateLabel(held) : "Default"}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40" data-design-state-menu="">
        <DropdownMenuRadioGroup
          value={held ?? DEFAULT}
          onValueChange={(value) => onPick(value === DEFAULT ? null : (value as DesignRuntimeNodeState))}
        >
          <DropdownMenuRadioItem value={DEFAULT}>Default</DropdownMenuRadioItem>
          {states.map((state) => (
            <DropdownMenuRadioItem key={state} value={state}>
              {designStateLabel(state)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What the held state changes, and the way back. */
export function designHeldStateNote(state: DesignRuntimeNodeState, count: number): { lead: string; rest: string } {
  const lead = designStateLabel(state);
  if (count === 0) return { lead, rest: " changes nothing here." };
  return { lead, rest: ` changes ${count} ${count === 1 ? "property" : "properties"}. The rest matches Default.` };
}

export function DesignHeldStateNote({
  state,
  count,
  onBack,
}: {
  state: DesignRuntimeNodeState;
  count: number;
  onBack: () => void;
}) {
  const note = designHeldStateNote(state, count);
  return (
    <div
      data-design-state-control=""
      data-design-state-note=""
      className="border-border1 text-fg3 flex min-h-7 items-center gap-2 border-b py-0.5 pr-2 pl-3 text-3xxs leading-4"
    >
      <span className="min-w-0 flex-1">
        <b className="text-fg2 font-medium">{note.lead}</b>
        {note.rest}
      </span>
      <Button type="button" variant="ghost" size="compact" onClick={onBack}>
        Back to Default
      </Button>
    </div>
  );
}

const READ_ONLY_EVENTS = ["pointerdown", "mousedown", "click", "dblclick", "auxclick", "contextmenu", "keydown", "beforeinput", "paste", "cut", "drop", "dragstart"] as const;
/** Keys a field steps its value with, whatever the modifiers. */
const STEPPING_KEYS = new Set(["ArrowUp", "ArrowDown"]);
/** Keys that move focus or the caret, or leave, and change nothing. */
const PASSING_KEYS = new Set(["Tab", "Escape", "ArrowLeft", "ArrowRight", "Home", "End", "Shift", "Meta", "Control", "Alt", "CapsLock"]);

/** Whether an event falls on something a held state keeps read-only: the
 * panel's scrolling content (its fields and the Styled-by rows) and the
 * Design popovers and token picker portaled from it. The State button, the
 * note, the tabs and the scrollbar stay usable. */
export function designHeldStateBlocks(root: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-design-state-control]")) return false;
  const popover = target.closest("[data-design-popover], [data-design-token-picker]");
  if (popover) return designPopoverOpenedFrom(root, popover);
  const viewport = target.closest("[data-radix-scroll-area-viewport]");
  return Boolean(viewport && root.contains(viewport));
}

/** A portaled popover belongs to the panel when its trigger (the element
 * whose aria-controls names it) is inside the panel. The panel's popovers
 * with no trigger, such as its token picker, belong to it as well; one
 * opened elsewhere, such as the theme editor's colour picker, does not. */
function designPopoverOpenedFrom(root: HTMLElement, popover: Element): boolean {
  if (!popover.id) return true;
  for (const trigger of document.querySelectorAll("[aria-controls]")) {
    if (trigger.getAttribute("aria-controls") === popover.id) return root.contains(trigger);
  }
  return true;
}

/** While a state is held, nothing in the panel edits: presses, typing,
 * cutting, pasting, stepping arrows (with any modifier) and field shortcuts
 * are dropped before any field sees them, at the document so portaled
 * popovers are covered too. Undo, redo, copy and other Cmd/Ctrl shortcuts,
 * Tab and Escape pass. Listeners exist only while held. */
export function useDesignHeldReadOnly(rootRef: RefObject<HTMLElement | null>, held: boolean): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!held || !root) return;
    const block = (event: Event) => {
      if (!designHeldStateBlocks(root, event.target)) return;
      if (event instanceof KeyboardEvent && !STEPPING_KEYS.has(event.key)) {
        if (PASSING_KEYS.has(event.key)) return;
        if ((event.metaKey || event.ctrlKey) && !event.altKey) return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    for (const type of READ_ONLY_EVENTS) document.addEventListener(type, block, true);
    return () => {
      for (const type of READ_ONLY_EVENTS) document.removeEventListener(type, block, true);
    };
  }, [held, rootRef]);
}
