// ──────────────────────────────────────────────────────────
// AgentModelPicker — the dispatcher's agent+model pill
// ──────────────────────────────────────────────────────────
//
// A thin trigger around the shared AgentModelMenu (the unified agent+model
// dropdown the chat composer's ModelPill also opens — ★ favorites rail, one
// tab per agent, search, 1/2/3 + ⌘1…⌘9 shortcuts). The dispatcher exists
// pre-creation, so a pick under a different agent simply swaps the pending
// selection — the parent re-derives effort/fast/permissions for it.
//
// Pre-session, `modelsForAgent(agentId, null)` returns the curated catalog,
// which is exactly the stable list the menu shows.
// ──────────────────────────────────────────────────────────

import { useState } from "react";

import { AgentIcon } from "../../zeros/agent/agent-icon";
import { TOOLBAR_PILL } from "../../zeros/agent/composer-pills";
import {
  AgentModelMenu,
  type AgentModelSelection,
} from "../../zeros/agent/agent-model-menu";
import {
  displayModelLabel,
  modelsForAgent,
} from "../../zeros/agent/model-catalog";
import { effectiveFavoriteModel } from "../../zeros/agent/model-favorites";
import type { BridgeRegistryAgent } from "../../zeros/bridge/messages";

export type { AgentModelSelection };

interface AgentModelPickerProps {
  /** Registry snapshot — null while loading. Filtered to runnable agents
   *  that have a curated catalog so no empty groups render. */
  agents: BridgeRegistryAgent[] | null;
  /** Current selection (drives the trigger label + the ✓). */
  value: AgentModelSelection | null;
  onChange: (next: AgentModelSelection) => void;
}

export function AgentModelPicker({ agents, value, onChange }: AgentModelPickerProps) {
  const [open, setOpen] = useState(false);

  // Trigger label — the current agent's icon + the model's display label,
  // matching the composer ModelPill so the two read as one control. A null
  // model resolves to the agent's effective favorite (what a created chat
  // would actually open on).
  const models = value ? modelsForAgent(value.agentId, null) : [];
  const activeModel =
    value?.model ??
    (value ? effectiveFavoriteModel(value.agentId) : null) ??
    models[0]?.value ??
    null;
  const triggerLabel = value
    ? displayModelLabel(
        value.agentId,
        models.find((m) => m.value === activeModel)?.label ??
          activeModel ??
          "Model",
      )
    : "Model";

  return (
    <AgentModelMenu
      agents={agents}
      value={value ? { agentId: value.agentId, model: activeModel } : null}
      open={open}
      onOpenChange={setOpen}
      onSelect={onChange}
    >
      {/* 2026-07-10 (user spec): 12px logo, and no ChevronDown caret —
          matching the chat composer's ModelPill. */}
      <button type="button" className={TOOLBAR_PILL}>
        <AgentIcon
          agentId={value?.agentId ?? null}
          iconUrl={null}
          size={12}
          monochrome
          className="shrink-0"
        />
        <span>{triggerLabel}</span>
      </button>
    </AgentModelMenu>
  );
}
