import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDocumentActive } from "../../state/use-document-active";
import { useReadRecovery } from "../../state/use-read-recovery";

type HistoryStatus = "none" | "loading" | "waiting" | "unavailable";

/** A bounded presentation of a cold read, never a transcript/transport deadline.
 * UNKNOWN is not ongoing work. Readable rows revalidate silently; a new chat
 * with no known history does not need a loading state at all. */
export function useTranscriptHistoryStatus({
  identity,
  active,
  hasMessages,
  hasTranscript,
  resident,
  error,
  connected = true,
  retry,
}: {
  identity: string;
  active: boolean;
  hasMessages: boolean;
  hasTranscript: boolean;
  resident: boolean;
  error?: string | null;
  connected?: boolean;
  retry?: () => Promise<void>;
}): HistoryStatus {
  const visible = useDocumentActive(active);
  const pending = !resident && !hasMessages && hasTranscript;
  const readError = useMemo(() => error ? new Error(error) : null, [error]);
  const recovery = useReadRecovery(`transcript:${identity}`, {
    error: resident ? null : readError,
    pending: !resident && !error,
    hasContent: hasMessages,
    active: visible && !resident && !hasMessages,
    connected,
    retry: () => retry?.(),
  });
  const coldRead = useRef<{ identity: string; startedAt: number } | null>(null);
  const [presentation, setPresentation] = useState({ identity, status: "none" as HistoryStatus });

  useLayoutEffect(() => {
    const publish = (status: HistoryStatus) => setPresentation(current =>
      current.identity === identity && current.status === status ? current : { identity, status });
    if (!pending) coldRead.current = null;
    else if (coldRead.current?.identity !== identity) {
      coldRead.current = { identity, startedAt: performance.now() };
    }
    // Retain the original observation time across hide/reveal, but no timer.
    // A late read cannot restart the loading animation on each tab switch.
    if (!visible || !pending) {
      publish("none");
      return;
    }
    const startedAt = coldRead.current!.startedAt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retired = false;
    const update = () => {
      if (retired) return;
      const elapsed = performance.now() - startedAt;
      // Stop the animation on a slow read without inventing a failure. Only
      // a rejected read that fails recovery can offer an unavailable state.
      const status = elapsed < 180 ? "none" : elapsed < 2_500 ? "loading" : "waiting";
      publish(status);
      const next = elapsed < 180 ? 180 : 2_500;
      if (elapsed < next) timer = setTimeout(update, next - elapsed);
    };
    update();
    return () => {
      retired = true;
      clearTimeout(timer);
    };
  }, [identity, visible, pending]);

  if (!visible || hasMessages || resident) return "none";
  if (recovery.error) return "unavailable";
  return pending && presentation.identity === identity ? presentation.status : "none";
}
