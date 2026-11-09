// ──────────────────────────────────────────────────────────
// Agent-removed placeholder
// ──────────────────────────────────────────────────────────
//
// Rendered in place of the chat body (composer + transcript) when an
// existing chat is bound to an agentId the registry no longer knows
// about — i.e. the adapter was removed from the product. The first
// case is the retired `gemini` CLI: persisted threads still carry
// `agentId: "gemini"`, but there's no adapter to spawn.
//
// We deliberately do NOT auto-swap the agent under the user (that would
// silently change which model answers an in-flight thread). Instead we
// stop here, keep the on-disk history intact, and offer one explicit
// action — "Switch agent" — which clears the dead binding so the normal
// auto-bind picks the resolved default; the composer's agent pill then
// lets the user pick any other available agent.
//
// Distinct from "not installed" (Settings → Providers handles that):
// a removed agent can't be reinstalled from inside Zeros at all.
// Styling mirrors WorktreeMissingPanel for a consistent dead-end card.
// ──────────────────────────────────────────────────────────

import React from "react";
import { ArrowLeftRight, Bot } from "lucide-react";

import { Button } from "../shared/ui";

export interface AgentRemovedPanelProps {
  agentId: string;
  agentName?: string | null;
  onSwitchAgent: () => void;
}

export function AgentRemovedPanel({
  agentId,
  agentName,
  onSwitchAgent,
}: AgentRemovedPanelProps) {
  const label = agentName?.trim() || agentId;

  return (
    <div className="flex h-full w-full items-center justify-center bg-bg1 p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <div className="flex size-12 items-center justify-center rounded-sm border border-border1 bg-bg2">
          <Bot className="size-6 text-muted-fg" aria-hidden="true" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium text-fg1">
            Agent no longer available
          </h3>
          <p className="text-xs text-fg2 leading-relaxed">
            This chat was created with{" "}
            <span className="text-fg1">{label}</span>, which has been removed
            from Zeros. Its history is preserved, but it can’t run new prompts.
            Switch this chat to an available agent to continue.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onSwitchAgent}>
          <ArrowLeftRight size={14} aria-hidden="true" />
          Switch agent
        </Button>
      </div>
    </div>
  );
}
