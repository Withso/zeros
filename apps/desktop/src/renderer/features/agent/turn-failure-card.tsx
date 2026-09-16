import { useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/renderer/shared/ui/primitives/button";
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
  // Plain text is escaped by React. Only explicit web URLs become links;
  // provider HTML, Markdown commands and other URL schemes remain text.
  const parts = failure.message.split(
    /(https?:\/\/[^\s<>"\]]+[^\s<>"\].,;)])/g,
  );
  return (
    <div
      role="status"
      data-turn-failure-card
      className="bg-brown-bg text-fg1 my-2 rounded-md p-3 text-sm"
    >
      <div className="break-words whitespace-pre-wrap">
        {parts.map((part, index) =>
          /^https?:\/\//.test(part) ? (
            <a
              key={index}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              className="text-fg1 underline underline-offset-2"
            >
              {part}
            </a>
          ) : (
            part
          ),
        )}
      </div>
      {(onRetry || onRetryNewChat) && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {onRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void retry(onRetry)}
              className="text-brown-fg hover:text-brown-fg gap-1 px-0"
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
              className="text-brown-fg hover:text-brown-fg gap-1 px-0"
            >
              Retry in new chat{" "}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
      {retryError && (
        <div role="alert" className="mt-2">
          {retryError}
        </div>
      )}
    </div>
  );
}
