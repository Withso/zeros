// Retention: a cloud workspace restored without some of its work says so once,
// in plain words, until its own member dismisses it. The control plane shows
// `lostWork` only to that member, so a teammate never sees it.
import { useState, useSyncExternalStore } from "react";
import { cloudTargetForValue } from "../../platform/bridge/cloud-workspace-key";
import { cloudV2Document, dismissCloudV2LostWork } from "../../platform/cloud-v2";
import type { CloudLostWork } from "../../platform/cloud-workspace-contract";
import { Button } from "../../shared/ui/primitives";
import { toast } from "../../shared/ui/primitives/elements";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { acceptCloudWorkspaceDocument, cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The notice's one line. */
export function lostWorkMessage(lostWork: CloudLostWork): string {
  return lostWork.restored === "none"
    ? `This workspace was rebuilt from GitHub. Work that was not pushed before ${when(lostWork.stoppedAt)} could not be recovered.`
    : `This workspace was restored from an earlier backup. Work after ${when(lostWork.stoppedAt)} that was not pushed could not be recovered.`;
}

export function LostWorkNotice({ folder }: { folder: string | null | undefined }) {
  let target: ReturnType<typeof cloudTargetForValue> = null;
  try { target = cloudTargetForValue(folder); } catch { target = null; }
  const read = () => (target ? cloudWorkspaceDocument(target)?.lostWork : undefined);
  const lostWork = useSyncExternalStore(subscribeCloudWorkspaces, read, read);
  const [busy, setBusy] = useState(false);
  if (!target || !lostWork) return null;
  const message = lostWorkMessage(lostWork);
  const dismiss = async () => {
    setBusy(true);
    try { acceptCloudWorkspaceDocument(cloudV2Document(await dismissCloudV2LostWork(target!))); }
    catch (error) { toast.error("Couldn't dismiss the notice", { description: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };
  return (
    <MessageRow tone="warning" flush role="status" title={message}
      actions={<Button variant="ghost" size="compact" disabled={busy} onClick={() => void dismiss()}>Dismiss</Button>}>
      {message}
    </MessageRow>
  );
}
