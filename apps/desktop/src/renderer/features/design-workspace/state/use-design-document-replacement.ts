import { useEffect, useRef, useState } from "react";
import { designDocumentReplacements, type DesignDocumentReplacement } from "./design-document-replacements";

export function useDesignDocumentReplacement(key: string | null, selected: boolean): DesignDocumentReplacement | null {
  const [admitted, setAdmitted] = useState<{ key: string; ticket: DesignDocumentReplacement } | null>(null);
  const request = useRef<DesignDocumentReplacement | null>(null);
  const priority = useRef(selected);
  priority.current = selected;
  useEffect(() => {
    setAdmitted(null);
    if (!key) return;
    let cancelled = false;
    let stopWaiting: (() => void) | undefined;
    const attempt = () => {
      if (cancelled || request.current) return;
      request.current = designDocumentReplacements.request(priority.current, (ticket) => {
        if (!cancelled) setAdmitted({ key, ticket });
      });
      if (!request.current) stopWaiting ??= designDocumentReplacements.subscribeAvailable(attempt);
    };
    attempt();
    return () => {
      cancelled = true;
      stopWaiting?.();
      request.current?.cancel();
      request.current = null;
    };
  }, [key]);
  useEffect(() => { request.current?.prioritize(selected); }, [selected]);
  return admitted?.key === key && !admitted.ticket.cancelled ? admitted.ticket : null;
}
