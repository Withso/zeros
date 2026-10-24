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

  if (state.trigger === "#") return (
    <PrPicker items={state.items as PrPickerItem[]} status={state.status}
      highlightIndex={state.selectedIndex} onHover={onHover}
      onPick={pr => store.chooseItem(pr)} />
  );
  return (
    <Popover open onOpenChange={open => { if (!open) store.dismiss(); }}>
      {placement === "caret" ? <PopoverAnchor virtualRef={anchor} /> : (
        <PopoverAnchor aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0" />
      )}
      <PopoverContent
        data-composer-suggestions={state.trigger}
        aria-label={state.trigger === "@" ? "Mention files" : "Commands and skills"}
        side={placement === "caret" ? "bottom" : "top"} align="start" sideOffset={6} size="wide" padding="none"
        className={placement === "composer" ? "w-(--radix-popover-trigger-width)" : undefined}
        updatePositionStrategy="always"
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        onInteractOutside={event => {
          if (event.target instanceof Node && state.anchor?.element.contains(event.target)) event.preventDefault();
        }}
      >
      <Surface kind="floating">
      {state.trigger === "@" ? (
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
