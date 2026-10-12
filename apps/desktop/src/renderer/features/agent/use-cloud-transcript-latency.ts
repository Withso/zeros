import { useLayoutEffect } from "react";
import { observeCloudTranscriptPaint, observeCloudTranscriptLoading } from "../../state/cloud-workspace-latency";

export function useCloudTranscriptLatency(folder: string | null | undefined, chatId: string | undefined, active: boolean, ready: boolean, hasHistory: boolean): void {
  useLayoutEffect(() => {
    if (!folder || !chatId || !active || !ready) return;
    return observeCloudTranscriptPaint(folder, chatId, hasHistory);
  }, [folder, chatId, active, ready, hasHistory]);
}

export function useCloudTranscriptLoading(folder: string | null | undefined, chatId: string | undefined, visible: boolean): void {
  useLayoutEffect(() => {
    if (!folder || !chatId || !visible) return;
    return observeCloudTranscriptLoading(folder, chatId);
  }, [folder, chatId, visible]);
}
