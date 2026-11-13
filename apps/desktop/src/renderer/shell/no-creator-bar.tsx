import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { UserX } from "lucide-react";
import { Button } from "../shared/ui/primitives/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../shared/ui/primitives/dialog";
import { toast } from "../shared/ui/primitives/elements";
import { cloudWorkspaceDocumentTitle } from "../shared/lib/workspace-name";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { listReassignCandidates, reassignCloudWorkspace, type ReassignCandidate } from "../platform/team-sharing";
import { workspaceAccessScope } from "../platform/team-sharing-registry";
import { useMyUserId } from "../platform/team-sharing-state";
import { openReassignDialog } from "../platform/reassign-dialog-signal";
import { acceptCloudWorkspaceDocument, cloudWorkspaceDocument, refreshCloudWorkspace, subscribeCloudWorkspaces } from "../state/cloud-workspace-catalog";
import { makeMeCreatorConfirmCopy, noCreatorBarKind, selfCreatorEligibility } from "../features/team/no-creator-model";
import { reassignErrorMessage, reassignNextRequestId } from "../features/team/reassign-model";
import { ComposerReplacementBar } from "./composer-replacement-bar";

const code = (error: unknown) => String((error as { code?: unknown } | null)?.code);

/** No-Creator bar (owner decision 2026-11-13): in place of the composer while the workspace has no Creator. An admin
 * gets "Make me the Creator" (one confirm) and "Reassign…"; a member gets the plain line. It clears the moment the
 * document shows a Creator. Chats above load and scroll as usual; files, terminal and Git keep working. */
export function NoCreatorBar({ folder, surfaceActive }: { folder: string; surfaceActive: boolean }) {
  const target = parseCloudWorkspaceKey(folder);
  const read = () => (target ? cloudWorkspaceDocument(target) : undefined);
  const doc = useSyncExternalStore(subscribeCloudWorkspaces, read, read);
  const me = useMyUserId();
  const kind = noCreatorBarKind(doc);
  const revision = doc?.sharing?.ownership?.creatorRevision;
  // Exact key: account session, organization, workspace, Creator revision and viewer. A reply for another key is dropped.
  const key = target && kind === "admin" && revision ? `${workspaceAccessScope() ?? ""}|${target.organizationId}|${target.workspaceId}|${revision}|${me ?? ""}` : null;
  const [listed, setListed] = useState<{ key: string; candidates: ReassignCandidate[] | null } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const held = useRef<{ requestId: string; toUserId: string } | undefined>(undefined);

  useEffect(() => {
    if (!key || !target || !surfaceActive) return;
    const controller = new AbortController();
    listReassignCandidates(target, controller.signal).then(
      reply => { if (!controller.signal.aborted) setListed({ key, candidates: reply.candidates }); },
      () => { if (!controller.signal.aborted) setListed({ key, candidates: null }); });
    return () => controller.abort();
    // target is derived from folder; key carries every field that selects the answer.
  }, [key, surfaceActive]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target || !doc || !kind) return null;
  if (kind === "member")
    return <ComposerReplacementBar icon={<UserX className="text-fg2 size-4 shrink-0" aria-hidden="true" />}
      message="This workspace has no Creator. An admin can reassign it." cardProps={{ "data-no-creator": "member" }} />;

  const self = selfCreatorEligibility(listed?.key === key ? listed.candidates : undefined, me);
  const confirm = async () => {
    if (!me || !revision) return;
    held.current = reassignNextRequestId(held.current, me);
    setSubmitting(true); setMessage(null);
    try {
      const result = await reassignCloudWorkspace(target, { ...held.current, expectedCreatorUserId: null, expectedCreatorRevision: revision });
      acceptCloudWorkspaceDocument(result.workspace);
      toast.success("You're now the Creator");
      setConfirming(false);
    } catch (error) {
      const failure = code(error);
      if (failure === "reassign_conflict") held.current = undefined;
      if (["creator_changed", "reassign_conflict", "assignee_ineligible", "workspace_management_denied", "team_ownership_required"].includes(failure)) {
        setConfirming(false); void refreshCloudWorkspace(target).catch(() => {});
      }
      setMessage(reassignErrorMessage(failure));
    } finally { setSubmitting(false); }
  };
  const copy = makeMeCreatorConfirmCopy(cloudWorkspaceDocumentTitle(doc));
  return (
    <>
      <ComposerReplacementBar
        icon={<UserX className="text-fg2 size-4 shrink-0" aria-hidden="true" />}
        message="This workspace has no Creator."
        cardProps={{ "data-no-creator": "admin" }}
        {...(self.state === "ineligible" || (message && !confirming) ? {
          details: <>
            {self.state === "ineligible" && <p className="text-fg3 mt-1 text-xs">{self.reason}</p>}
            {message && !confirming && <p role="alert" className="text-red-fg mt-1 text-xs">{message}</p>}
          </>,
        } : {})}
        actions={<div className="flex shrink-0 items-center gap-2">
          {self.state === "eligible" && <Button variant="secondary" size="sm" onClick={() => { setMessage(null); setConfirming(true); }}>Make me the Creator</Button>}
          <Button variant="secondary" size="sm" onClick={() => openReassignDialog(target)}>Reassign…</Button>
        </div>}
      />
      {confirming && (
        <Dialog open onOpenChange={open => { if (!open && !submitting) setConfirming(false); }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{copy.title}</DialogTitle></DialogHeader>
            <DialogBody>
              <DialogDescription>{copy.body}</DialogDescription>
              {message && <p className="text-red-primary text-xs" role="alert">{message}</p>}
            </DialogBody>
            <DialogFooter>
              <Button variant="secondary" size="sm" disabled={submitting} onClick={() => setConfirming(false)}>Back</Button>
              <Button size="sm" loading={submitting} onClick={() => void confirm()}>Make me the Creator</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
