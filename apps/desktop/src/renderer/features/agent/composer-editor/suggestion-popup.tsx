// ──────────────────────────────────────────────────────────
// suggestion-popup.tsx — renders the live @ / slash / # picker
// ──────────────────────────────────────────────────────────
//
// Subscribes to the per-editor SuggestionStore and renders the EXISTING
// picker for whichever trigger is active. Workspace @ and / menus anchor
// above the composer; Create opts into a virtual anchor following the caret.
// ──────────────────────────────────────────────────────────

import { useMemo, useSyncExternalStore } from "react";

import type { SuggestionStore } from "./suggestion";
import { MentionPicker } from "../mention-picker";
import { SlashCommandPicker } from "../slash-command-picker";
import { PrPicker } from "../pr-picker";
import type { MentionItem } from "../mentions";
import type { AvailableCommand } from "../../../platform/bridge/agent-events";
import type { PrPickerItem } from "../pr-picker";
import { Popover, PopoverAnchor, PopoverContent } from "../../../shared/ui/primitives";
import { Surface } from "../../../shared/ui/layout/surface";

export function ComposerSuggestionPopup({
  store,
  agentId,
  active = true,
  placement = "composer",
}: {
  store: SuggestionStore;
  agentId: string | null;
  active?: boolean;
  placement?: "composer" | "caret";
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const anchor = useMemo(() => ({ current: {
    getBoundingClientRect: () => store.getSnapshot().anchor?.getBoundingClientRect() ?? new DOMRect(),
  } }), [store]);
  // Render while the trigger is open even with zero items — the pickers show a
  // real loading / error / empty message (the "/" path is synchronous, so its
  // empty branch just reads "No commands match.").
  if (!active || !state.open) return null;

  const onHover = (i: number) => store.setIndex(i);

  return (
    <Popover open onOpenChange={open => { if (!open) store.dismiss(); }}>
      {placement === "caret" ? <PopoverAnchor virtualRef={anchor} /> : (
        // On the composer's outer edge, past its 1px border, so the picker
        // matches the composer's width and stands 8px above it like a dock card.
        <PopoverAnchor aria-hidden="true" className="pointer-events-none absolute -inset-x-px -top-px h-0" />
      )}
      <PopoverContent
        data-composer-suggestions={state.trigger}
        aria-label={state.trigger === "@" ? "Mention files" : state.trigger === "#" ? "Pull requests" : "Commands and skills"}
        side={placement === "caret" ? "bottom" : "top"} align="start" size="wide" padding="none"
        // Docked on the composer, the picker is one more card above it: the
        // composer's surface, 8px up. At the caret it floats over the page.
        sideOffset={placement === "composer" ? 8 : 6}
        surface={placement === "composer" ? "composer" : "floating"}
        className={placement === "composer" ? "w-(--radix-popover-trigger-width)" : undefined}
        updatePositionStrategy="always"
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onInteractOutside={event => {
          if (event.target instanceof Node && state.anchor?.element.contains(event.target)) event.preventDefault();
        }}
      >
      <Surface kind={placement === "composer" ? "sidebar" : "floating"}>
      {state.trigger === "#" ? (
      <PrPicker items={state.items as PrPickerItem[]} status={state.status}
        highlightIndex={state.selectedIndex} onHover={onHover}
        onPick={pr => store.chooseItem(pr)} />
      ) : state.trigger === "@" ? (
      <MentionPicker
        items={state.items as MentionItem[]}
        status={state.status}
        highlightIndex={state.selectedIndex}
        onHover={onHover}
        onPick={(item) => store.chooseItem(item)}
      />
      ) : (
      <SlashCommandPicker
        commands={state.items as AvailableCommand[]}
        agentId={agentId}
        slashTab={state.slashTab}
        onTab={(t) => store.setSlashTab(t)}
        highlightIndex={state.selectedIndex}
        onHover={onHover}
        onPick={(cmd) => store.chooseItem(cmd)}
      />
      )}
      </Surface>
      </PopoverContent>
    </Popover>
  );
}
