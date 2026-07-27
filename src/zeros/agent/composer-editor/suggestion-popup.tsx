// ──────────────────────────────────────────────────────────
// suggestion-popup.tsx — renders the live @ / slash / # picker
// ──────────────────────────────────────────────────────────
//
// Subscribes to the per-editor SuggestionStore and renders the EXISTING
// picker for whichever trigger is active. The pickers self-position
// (absolute, bottom:calc(100%+6px)) relative to the composer card, so this
// must be mounted INSIDE the card (a position:relative container).
// ──────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";

import type { SuggestionStore } from "./suggestion";
import { MentionPicker } from "../mention-picker";
import { SlashCommandPicker } from "../slash-command-picker";
import { PrPicker } from "../pr-picker";
import type { MentionItem } from "../mentions";
import type { AvailableCommand } from "../../bridge/agent-events";
import type { PrPickerItem } from "../pr-picker";

export function ComposerSuggestionPopup({
  store,
  agentId,
}: {
  store: SuggestionStore;
  agentId: string | null;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // Render while the trigger is open even with zero items — the pickers show a
  // real loading / error / empty message (the "/" path is synchronous, so its
  // empty branch just reads "No commands match.").
  if (!state.open) return null;

  const onHover = (i: number) => store.setIndex(i);

  if (state.trigger === "@") {
    return (
      <MentionPicker
        items={state.items as MentionItem[]}
        status={state.status}
        highlightIndex={state.selectedIndex}
        onHover={onHover}
        onPick={(item) => store.chooseItem(item)}
      />
    );
  }
  if (state.trigger === "/") {
    return (
      <SlashCommandPicker
        commands={state.items as AvailableCommand[]}
        agentId={agentId}
        slashTab={state.slashTab}
        onTab={(t) => store.setSlashTab(t)}
        highlightIndex={state.selectedIndex}
        onHover={onHover}
        onPick={(cmd) => store.chooseItem(cmd)}
      />
    );
  }
  return (
    <PrPicker
      items={state.items as PrPickerItem[]}
      status={state.status}
      highlightIndex={state.selectedIndex}
      onHover={onHover}
      onPick={(pr) => store.chooseItem(pr)}
    />
  );
}
