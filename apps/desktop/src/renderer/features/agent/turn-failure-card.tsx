import { useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/renderer/shared/ui/primitives/button";
import {
  AGENT_NOTICE_ACTION,
  AgentNotice,
  AgentNoticeText,
} from "./agent-notice";
import { turnFailureDisplay, type TurnFailure } from "./turn-failure";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";
import { memberName, useOrganizationRoster } from "../../state/organization-roster";

/** Creator pays: the cloud workspace's current Creator's name, only when a failure names the Creator. */
function useCreatorName(folder: string | null | undefined, needed: boolean): string | null {
  const target = needed ? parseCloudWorkspaceKey(folder ?? undefined) : null;
  const read = () => (target ? cloudWorkspaceDocument(target)?.ownerUserId ?? null : null);
  const creator = useSyncExternalStore(subscribeCloudWorkspaces, read, read);
  const roster = useOrganizationRoster(creator ? target?.organizationId : null, !!creator);
  return creator ? memberName(roster, creator) : null;
}

export function TurnFailureCard({
  failure,
  readOnly = false,
  onRetry,
  onRetryNewChat,
  onRetryNewChatIntent,
  onReconnect,
  onStartNewSession,
  onChooseModel,
  folder,
}: {
  failure: TurnFailure;
  /** The chat's workspace key, to name a cloud workspace's Creator. */
  folder?: string | null;
  readOnly?: boolean;
  onRetry?: () => Promise<void> | void;
  onRetryNewChat?: () => Promise<void> | void;
  onRetryNewChatIntent?: () => void;
  onReconnect?: (provider?: string) => void;
  onStartNewSession?: () => Promise<void> | void;
  onChooseModel?: () => void;
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
  const reason = failure.cloud?.source === "provider" ? failure.cloud.reason : undefined;
  const creatorName = useCreatorName(folder, failure.cloud?.source === "provider" && failure.cloud.loginRequiredFrom === "creator");
  const display = turnFailureDisplay(failure, creatorName);
  const retryAction = !readOnly && display.retry ? onRetry : undefined;
  const newChatAction = !readOnly && failure.newChatAllowed && (!reason || reason === "session-expired")
    ? reason === "session-expired" ? onStartNewSession ?? onRetryNewChat : onRetryNewChat : undefined;
  const reconnectAction = !readOnly && display.reconnect ? onReconnect : undefined;
  const modelAction = !readOnly && reason === "model-unavailable" ? onChooseModel : undefined;
  // The turn lane (turn-event-list.tsx) stacks this card between the output
  // and the footer row with no gap, so it keeps an 8px margin of its own —
  // except as the lane's first child, where TurnContainer's gap-4 already
  // separates it from the prompt.
  return (
    <AgentNotice
      message={display.message}
      data-turn-failure-card
      className="my-2 first:mt-0"
    >
      {(retryAction || newChatAction || reconnectAction || modelAction) && (
        <div className="mt-1 flex flex-wrap items-center gap-3">
          {modelAction && <Button type="button" variant="ghost" size="sm" disabled={busy}
            onClick={modelAction} className={AGENT_NOTICE_ACTION}>
            Choose another model <ArrowRight className="size-3.5" aria-hidden="true" />
          </Button>}
          {reconnectAction && <Button type="button" variant="ghost" size="sm" disabled={busy}
            onClick={() => reconnectAction(failure.cloud?.source === "provider" ? failure.cloud.provider : undefined)} className={AGENT_NOTICE_ACTION}>
            {display.reconnectLabel}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Button>}
          {retryAction && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void retry(retryAction)}
              className={AGENT_NOTICE_ACTION}
            >
              Retry <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
          )}
          {newChatAction && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onPointerEnter={onRetryNewChatIntent}
              onFocus={onRetryNewChatIntent}
              onClick={() => void retry(newChatAction)}
              className={AGENT_NOTICE_ACTION}
            >
              {reason === "session-expired" ? "Start a new session" : "Retry in new chat"}{" "}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
      {failure.cloud?.source === "provider" && failure.cloud.retryAt !== undefined && <p className="text-fg2 m-0 mt-1 text-xs">
        Retry after {new Date(failure.cloud.retryAt).toLocaleString()}.
      </p>}
      {retryError && (
        <div role="alert" className="mt-2">
          <AgentNoticeText message={retryError} />
        </div>
      )}
    </AgentNotice>
  );
}
