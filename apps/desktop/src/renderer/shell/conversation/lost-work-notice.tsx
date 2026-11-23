// Retention: a cloud workspace restored without some of its work says so once,
// in plain words, until its own member dismisses it. The control plane shows
// `lostWork` only to that member, so a teammate never sees it. The same row names
// any submodule a restore could not bring back yet (`unrestoredSubmodules`): that
// part has nothing to dismiss, and goes once a later open puts them back.
import { useState, useSyncExternalStore } from "react";
import { cloudTargetForValue } from "../../platform/bridge/cloud-workspace-key";
import { cloudV2Document, dismissCloudV2LostWork } from "../../platform/cloud-v2";
import type { CloudLostWork, CloudUnrestoredSubmodules } from "../../platform/cloud-workspace-contract";
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

/** The submodules part: how many, the first three by folder (below the VM user's home), and that Zeros tries again. */
export function unrestoredSubmodulesMessage(submodules: CloudUnrestoredSubmodules): string {
  const names = submodules.slice(0, 3).map(entry => entry.path.replace(/^\/home\/user\//, ""));
  const more = submodules.length > 3 ? ` and ${submodules.length - 3} more` : "";
  const count = submodules.length === 1 ? "1 submodule" : `${submodules.length} submodules`;
  return `${count} could not be brought back yet (${names.join(", ")}${more}). Zeros tries again each time this workspace opens.`;
}

export function LostWorkNotice({ folder }: { folder: string | null | undefined }) {
  let target: ReturnType<typeof cloudTargetForValue> = null;
  try { target = cloudTargetForValue(folder); } catch { target = null; }
  const read = () => (target ? cloudWorkspaceDocument(target)?.lostWork : undefined);
  const readSubmodules = () => (target ? cloudWorkspaceDocument(target)?.unrestoredSubmodules : undefined);
  const lostWork = useSyncExternalStore(subscribeCloudWorkspaces, read, read);
  const unrestored = useSyncExternalStore(subscribeCloudWorkspaces, readSubmodules, readSubmodules);
  const [busy, setBusy] = useState(false);
  if (!target || (!lostWork && !unrestored?.length)) return null;
  const message = [lostWork ? lostWorkMessage(lostWork) : null, unrestored?.length ? unrestoredSubmodulesMessage(unrestored) : null]
    .filter(Boolean).join(" ");
  const dismiss = async () => {
    setBusy(true);
    try { acceptCloudWorkspaceDocument(cloudV2Document(await dismissCloudV2LostWork(target!))); }
    catch (error) { toast.error("Couldn't dismiss the notice", { description: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };
  return (
    <MessageRow tone="warning" flush role="status" title={message}
      actions={lostWork ? <Button variant="ghost" size="compact" disabled={busy} onClick={() => void dismiss()}>Dismiss</Button> : undefined}>
      {message}
    </MessageRow>
  );
}
