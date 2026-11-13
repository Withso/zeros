import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CloudWorkspaceTarget } from "../../platform/bridge/cloud-workspace-key";
import { listReassignCandidates, reassignCloudWorkspace } from "../../platform/team-sharing";
import { closeReassignDialog, readReassignDialog, subscribeReassignDialog } from "../../platform/reassign-dialog-signal";
import { useMyUserId } from "../../platform/team-sharing-state";
import { acceptCloudWorkspaceDocument, cloudWorkspaceDocument, refreshCloudWorkspace, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";
import { memberName, useOrganizationRoster } from "../../state/organization-roster";
import { cloudWorkspaceDocumentTitle } from "../../shared/lib/workspace-name";
import { Button } from "../../shared/ui/primitives/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../shared/ui/primitives/command";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../shared/ui/primitives/dialog";
import { toast } from "../../shared/ui/primitives/elements";
import { reassignCandidateRows, reassignConfirmCopy, reassignErrorMessage, reassignNextRequestId, type ReassignRow } from "./reassign-model";

/** Team sharing 3B: one Reassign dialog for the app, opened (platform/reassign-dialog-signal) from a workspace row,
 * its details or a no-Creator refusal. */
export function ReassignDialogHost() {
  const target = useSyncExternalStore(subscribeReassignDialog, readReassignDialog, readReassignDialog);
  return target ? <ReassignDialog key={`${target.organizationId}:${target.workspaceId}`} target={target} /> : null;
}

const code = (error: unknown) => (error as { code?: unknown } | null)?.code;

function ReassignDialog({ target }: { target: CloudWorkspaceTarget }) {
  const readDoc = () => cloudWorkspaceDocument(target);
  const doc = useSyncExternalStore(subscribeCloudWorkspaces, readDoc, readDoc);
  const me = useMyUserId();
  const roster = useOrganizationRoster(target.organizationId, true);
  const revision = doc?.sharing?.ownership?.creatorRevision;
  const [candidates, setCandidates] = useState<Parameters<typeof reassignCandidateRows>[0] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReassignRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const held = useRef<{ requestId: string; toUserId: string } | undefined>(undefined);

  // Exact key: this workspace and its Creator revision. The last confirmed list stays while a new revision loads.
  useEffect(() => {
    if (!revision) return;
    const controller = new AbortController();
    listReassignCandidates(target, controller.signal).then(reply => { if (!controller.signal.aborted) setCandidates(reply.candidates); },
      error => { if (!controller.signal.aborted) setMessage(reassignErrorMessage(String(code(error)))); });
    return () => controller.abort();
  }, [target, revision]);
  const rows = useMemo(() => candidates ? reassignCandidateRows(candidates, roster) : null, [candidates, roster]);

  const visible = useMemo(() => (rows ?? []).filter(row => row.name.toLowerCase().includes(query.trim().toLowerCase())), [rows, query]);
  // No longer allowed (role changed, switch off): close.
  useEffect(() => { if (doc && !doc.sharing?.ownership?.canReassign && !submitting) closeReassignDialog(); }, [doc, submitting]);
  if (!doc?.sharing?.ownership) return null;

  const creatorName = doc.ownerUserId === null || doc.ownerUserId === undefined ? null : doc.ownerUserId === me ? "you" : memberName(roster, doc.ownerUserId);
  const confirm = async (row: ReassignRow) => {
    held.current = reassignNextRequestId(held.current, row.userId);
    setSubmitting(true); setMessage(null);
    try {
      const result = await reassignCloudWorkspace(target, { ...held.current, expectedCreatorUserId: doc.ownerUserId ?? null,
        expectedCreatorRevision: doc.sharing!.ownership!.creatorRevision });
      acceptCloudWorkspaceDocument(result.workspace);
      toast.success(`${row.name} is now the Creator`);
      closeReassignDialog();
    } catch (error) {
      const failure = String(code(error));
      if (failure === "workspace_management_denied" || failure === "team_ownership_required") { closeReassignDialog(); void refreshCloudWorkspace(target).catch(() => {}); return; }
      if (failure === "reassign_conflict") held.current = undefined;
      if (failure === "creator_changed" || failure === "reassign_conflict" || failure === "assignee_ineligible") { setPicked(null); void refreshCloudWorkspace(target).catch(() => {}); }
      setMessage(reassignErrorMessage(failure, row.name));
    } finally { setSubmitting(false); }
  };

  if (picked) {
    const copy = reassignConfirmCopy({ workspace: cloudWorkspaceDocumentTitle(doc), to: picked.name, caller: doc.ownerUserId === me ? "creator" : "admin", creator: creatorName });
    return (
      <Dialog open onOpenChange={open => { if (!open && !submitting) setPicked(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{copy.title}</DialogTitle></DialogHeader>
          <DialogBody>
            <DialogDescription>{copy.body}{copy.follow ? <><br />{copy.follow}</> : null}</DialogDescription>
            {message && <p className="text-red-primary text-xs" role="alert">{message}</p>}
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="sm" disabled={submitting} onClick={() => setPicked(null)}>Back</Button>
            <Button size="sm" loading={submitting} onClick={() => void confirm(picked)}>Make Creator</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <CommandDialog open onOpenChange={open => { if (!open) closeReassignDialog(); }} shouldFilter={false}
      title="Reassign Creator" description="The Creator's agent logins run every turn in this workspace.">
      <CommandInput placeholder="Search people…" value={query} onValueChange={setQuery} />
      <CommandList>
        {message && <p className="text-red-primary px-3 py-2 text-xs" role="alert">{message}</p>}
        <CommandEmpty>{rows ? "No one matches." : "Loading…"}</CommandEmpty>
        <CommandGroup>
          {visible.map(row => (
            <CommandItem key={row.userId} value={row.userId} disabled={!row.eligible} onSelect={() => { setMessage(null); setPicked(row); }} className="gap-2">
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {row.hint && <span className="text-muted-fg text-2xxs shrink-0">{row.hint}</span>}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
