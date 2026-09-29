import { useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/renderer/shared/ui/primitives/button";
import {
  AGENT_NOTICE_ACTION,
  AgentNotice,
  AgentNoticeText,
} from "./agent-notice";
import type { TurnFailure } from "./turn-failure";

export function TurnFailureCard({
  failure,
  onRetry,
  onRetryNewChat,
  onRetryNewChatIntent,
}: {
  failure: TurnFailure;
  onRetry?: () => Promise<void> | void;
  onRetryNewChat?: () => Promise<void> | void;
  onRetryNewChatIntent?: () => void;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const retry = async (action: () => Promise<void> | void) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setRetryError(null);
    try {
      await action();
    } catch (error) {
      setRetryError(
        error instanceof Error
          ? error.message
          : "Could not retry. Please try again.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  // The turn lane (turn-event-list.tsx) stacks this card between the output
  // and the footer row with no gap, so it keeps an 8px margin of its own —
  // except as the lane's first child, where TurnContainer's gap-4 already
  // separates it from the prompt.
  return (
    <AgentNotice
      message={failure.message}
      data-turn-failure-card
      className="my-2 first:mt-0"
    >
      {(onRetry || (onRetryNewChat && failure.newChatAllowed)) && (
        <div className="mt-1 flex flex-wrap items-center gap-3">
          {onRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void retry(onRetry)}
              className={AGENT_NOTICE_ACTION}
            >
              Retry <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
          )}
          {onRetryNewChat && failure.newChatAllowed && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onPointerEnter={onRetryNewChatIntent}
              onFocus={onRetryNewChatIntent}
              onClick={() => void retry(onRetryNewChat)}
              className={AGENT_NOTICE_ACTION}
            >
              Retry in new chat{" "}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
      {retryError && (
        <div role="alert" className="mt-2">
          <AgentNoticeText message={retryError} />
        </div>
      )}
    </AgentNotice>
  );
}
