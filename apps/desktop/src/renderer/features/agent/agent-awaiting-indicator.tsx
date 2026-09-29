import { ClipboardList, MessageCircleQuestionMark } from "lucide-react";

import { cn } from "../../shared/ui/cn";
import { Tooltip } from "../../shared/ui/primitives/tooltip";

import type { ChatAwaitingKind } from "./sessions-store";

type AwaitingKind = Exclude<ChatAwaitingKind, null>;

export const AGENT_AWAITING_LABEL: Record<AwaitingKind, string> = {
  plan: "Plan ready for review",
  input: "Agent awaiting your input",
};

/** A chat parked on the user: a clipboard while its plan waits for review, a
 *  question bubble while a question or permission waits for an answer. An
 *  agent can still be working while it asks, so the mark gets a slot of its
 *  own and never replaces the agent's icon, loader or workspace square. */
export function AgentAwaitingIcon({
  kind,
  className,
  strokeWidth,
}: {
  kind: AwaitingKind;
  className?: string;
  strokeWidth?: number;
}) {
  const Icon = kind === "plan" ? ClipboardList : MessageCircleQuestionMark;
  return (
    <Icon
      className={className}
      strokeWidth={strokeWidth}
      aria-hidden="true"
      data-agent-awaiting={kind}
    />
  );
}

/** The labelled mark for a chat tab's trailing slot, sized like
 *  ComposerDraftIndicator, which it outranks there. */
export function AgentAwaitingIndicator({
  kind,
  className,
}: {
  kind: AwaitingKind;
  className?: string;
}) {
  return (
    <Tooltip label={AGENT_AWAITING_LABEL[kind]} side="bottom">
      <span
        className={cn(
          "text-fg2 inline-flex size-3 shrink-0 items-center justify-center",
          className,
        )}
        role="img"
        aria-label={AGENT_AWAITING_LABEL[kind]}
      >
        <AgentAwaitingIcon kind={kind} className="size-3" />
      </span>
    </Tooltip>
  );
}
