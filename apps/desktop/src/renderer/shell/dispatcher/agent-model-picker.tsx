// ──────────────────────────────────────────────────────────
// AgentModelPicker — the dispatcher's agent+model pill
// ──────────────────────────────────────────────────────────
//
// A thin trigger around the shared AgentModelMenu (the unified agent+model
// dropdown the chat composer's ModelPill also opens — one global ★, one tab per
// agent, and universal search). The dispatcher exists
// pre-creation, so a pick under a different agent simply swaps the pending
// selection — the parent re-derives effort/fast/permissions for it.
//
// Pre-session, `modelsForAgent(agentId, null)` returns the curated catalog,
// which is exactly the stable list the menu shows.
// ──────────────────────────────────────────────────────────

import { useState } from "react";

import { AgentIcon } from "../../features/agent/agent-icon";
import { TOOLBAR_PILL } from "../../features/agent/composer-pills";
import {
  AgentModelMenu,
  type AgentModelSelection,
} from "../../features/agent/agent-model-menu";
import {
  configuredModelLabelParts,
  displayModelLabel,
  modelsForAgent,
} from "../../features/agent/model-catalog";
import { effectiveFavoriteModel } from "../../features/agent/model-favorites";
import type { ModelConfiguration } from "../../features/agent/model-preferences";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import type { ChatEffort } from "../../state/store";

export type { AgentModelSelection };

interface AgentModelPickerProps {
  /** Registry snapshot — null while loading. Filtered to runnable agents
   *  that have a curated catalog so no empty groups render. */
  agents: BridgeRegistryAgent[] | null;
  /** Current selection (drives the trigger label + the ✓). */
  value: AgentModelSelection | null;
  effort: ChatEffort;
  fast: boolean;
  onConfigure: (configuration: ModelConfiguration) => void;
  onChange: (next: AgentModelSelection) => void;
}

export function AgentModelPicker({
  agents,
  value,
  effort,
  fast,
  onConfigure,
  onChange,
}: AgentModelPickerProps) {
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
    ? configuredModelLabelParts(
        value.agentId,
        activeModel,
        models.find((m) => m.value === activeModel)?.label ??
          activeModel ??
          "Model",
        effort,
        fast,
      )
    : { model: displayModelLabel(null, "Model"), metadata: [] };

  return (
    <AgentModelMenu
      agents={agents}
      value={
        value
          ? { agentId: value.agentId, model: activeModel, effort, fast }
          : null
      }
      open={open}
      onOpenChange={setOpen}
      onSelect={onChange}
      onConfigure={onConfigure}
    >
      {/* 12px logo and no ChevronDown caret, matching the chat composer's
          ModelPill. */}
      <button type="button" className={TOOLBAR_PILL}>
        <AgentIcon
          agentId={value?.agentId ?? null}
          iconUrl={null}
          size={12}
          monochrome
          className="shrink-0"
        />
        <span data-model-pill-label>
          <span>{triggerLabel.model}</span>
          {triggerLabel.metadata.length > 0 && (
            <span
              data-model-pill-metadata
              className="text-fg2 opacity-80"
            >{` ${triggerLabel.metadata.join(" ")}`}</span>
          )}
        </span>
      </button>
    </AgentModelMenu>
  );
}
