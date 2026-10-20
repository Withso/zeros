import { useLayoutEffect, useRef, useState } from "react";
import { useDocumentActive } from "../../state/use-document-active";

type HistoryStatus = "none" | "loading" | "unavailable";

/** A bounded presentation of a cold read, never a transcript/transport deadline.
 * UNKNOWN is not ongoing work. Readable rows revalidate silently; a new chat
 * with no known history does not need a loading state at all. */
export function useTranscriptHistoryStatus({
  identity,
  active,
  hasMessages,
  hasTranscript,
  resident,
  incomplete,
}: {
  identity: string;
  active: boolean;
  hasMessages: boolean;
  hasTranscript: boolean;
  resident: boolean;
  incomplete: boolean;
}): HistoryStatus {
  const visible = useDocumentActive(active);
  const pending = !resident && !hasMessages && hasTranscript;
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
    if (!visible || !pending || incomplete) {
      publish("none");
      return;
    }
    const startedAt = coldRead.current!.startedAt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retired = false;
    const update = () => {
      if (retired) return;
      const elapsed = performance.now() - startedAt;
      const status = elapsed < 180 ? "none" : elapsed < 2_500 ? "loading" : "unavailable";
      publish(status);
      const next = elapsed < 180 ? 180 : 2_500;
      if (elapsed < next) timer = setTimeout(update, next - elapsed);
    };
    update();
    return () => {
      retired = true;
      clearTimeout(timer);
    };
  }, [identity, visible, pending, incomplete]);

  if (!visible || hasMessages) return "none";
  if (incomplete && !(resident && !hasTranscript)) return "unavailable";
  return pending && presentation.identity === identity ? presentation.status : "none";
}
