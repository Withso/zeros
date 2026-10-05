import { useEffect, useRef, useState } from "react";
import { RefreshCw, Trash2, Users } from "lucide-react";
import { useInternalFeatureActive } from "../../features/settings/internal-features";
import type { CloudWorkspaceActorRole, CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import {
  inviteCloudWorkspaceCollaborator, revokeCloudWorkspaceCollaborator, revokeCloudWorkspaceInvitation,
  setCloudWorkspaceCollaboratorRole, setCloudWorkspaceSharing,
  type CloudWorkspaceCollaboratorCollection, type CloudWorkspaceInvitationRole,
} from "../../platform/cloud-workspace-collaboration";
import {
  CLOUD_COLLABORATION_MAX_AGE_MS, cloudWorkspaceCollaboration, cloudWorkspaceCollaborationKey,
  cloudWorkspaceCollaborationOwner, warmCloudWorkspaceCollaboration,
} from "../../state/cloud-workspace-collaboration-cache";
import { refreshCloudWorkspace } from "../../state/cloud-workspace-catalog";
import { useCachedRead } from "../../state/use-cached-read";
import { Button, Input } from "../../shared/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { toast } from "../../shared/ui/primitives/elements";

const ROLE_LABELS: Record<CloudWorkspaceActorRole, string> = {
  owner: "Owner", manager: "Manager", developer: "Developer", prompter: "Prompter", viewer: "Viewer",
};
const ROLE_DESCRIPTION: Record<CloudWorkspaceActorRole, string> = {
  owner: "Manage this workspace, sharing and credentials.", manager: "Manage sharing and credentials.",
  developer: "Run agents and edit the workspace.", prompter: "Run agents. Direct edits and edit services are unavailable.",
  viewer: "Read-only access to the workspace.",
};
export function canManageCloudWorkspaceSharing(workspace: CloudWorkspaceDocument): boolean {
  return workspace.capabilities.canManage && ["owner", "manager"].includes(workspace.actorRole ?? "") &&
    workspace.sharingMode !== undefined && workspace.accessRevision !== undefined;
}

export function CloudWorkspaceSharingControls({ workspace, active }: { workspace: CloudWorkspaceDocument; active: boolean }) {
  const internal = useInternalFeatureActive("cloudComputerV2");
  const [expandedOwner, setExpandedOwner] = useState<string | null>(null);
  if (!internal || !active) return null;
  const owner = cloudWorkspaceCollaborationOwner({ organizationId: workspace.organizationId, workspaceId: workspace.id });
  const ownerKey = owner ? cloudWorkspaceCollaborationKey(owner) : null;
  const expanded = ownerKey !== null && expandedOwner === ownerKey;
  const role = workspace.actorRole;
  return (
    <section className="border-border1 mt-3 space-y-2 border-t pt-3" aria-label="Workspace sharing">
      <div className="text-fg2 flex items-center gap-2 text-xs">
        <Users size={14} strokeWidth={1.5} /> Sharing
        <span className="text-fg1 ml-auto">{workspace.sharingMode === "organization" ? "Organization" : workspace.sharingMode === "private" ? "Private" : "Unavailable"}</span>
      </div>
      <p className="text-fg2 text-xs">{role ? `${ROLE_LABELS[role]} · ${ROLE_DESCRIPTION[role]}` : "Workspace permissions are unavailable."}</p>
      {owner && canManageCloudWorkspaceSharing(workspace) && (
        <>
          <Button size="sm" aria-expanded={expanded} onClick={() => setExpandedOwner(expanded ? null : ownerKey)}
            onPointerEnter={() => warmCloudWorkspaceCollaboration(owner)} onFocus={() => warmCloudWorkspaceCollaboration(owner)}>
            {expanded ? "Hide collaborators" : "Manage sharing"}
          </Button>
          {expanded && <CloudWorkspaceSharingManager key={cloudWorkspaceCollaborationKey(owner)} workspace={workspace} active={active} />}
        </>
      )}
    </section>
  );
}

/** Mounted only while the cheap management view is visible. Forms are ephemeral
 * and remount for every account/device/workspace owner. */
export function CloudWorkspaceSharingManager({ workspace, active }: { workspace: CloudWorkspaceDocument; active: boolean }) {
  const internal = useInternalFeatureActive("cloudComputerV2");
  const owner = cloudWorkspaceCollaborationOwner({ organizationId: workspace.organizationId, workspaceId: workspace.id });
  const key = owner ? cloudWorkspaceCollaborationKey(owner) : null;
  const enabled = active && internal && canManageCloudWorkspaceSharing(workspace) && key !== null;
  const read = useCachedRead(cloudWorkspaceCollaboration.snapshots, enabled ? key : null,
    value => cloudWorkspaceCollaboration.fetch(value), { enabled, maxAgeMs: CLOUD_COLLABORATION_MAX_AGE_MS });
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [invitationRole, setInvitationRole] = useState<CloudWorkspaceInvitationRole>("viewer");
  const invitation = useRef<{ email: string; role: string; key: string } | null>(null);
  const alive = useRef(false);
  useEffect(() => { alive.current = enabled; return () => { alive.current = false; }; }, [enabled, key]);
  if (!enabled || !owner || !key) return null;
  const target = { organizationId: workspace.organizationId, workspaceId: workspace.id };
  const stillCurrent = () => {
    const current = cloudWorkspaceCollaborationOwner(target);
    return alive.current && current !== null && cloudWorkspaceCollaborationKey(current) === key;
  };
  const run = (write: () => Promise<unknown>, success: string, after?: () => void) => {
    if (busy || !read.data || read.error) return;
    setBusy(true);
    void cloudWorkspaceCollaboration.mutate(key, write).then(() => {
      if (stillCurrent()) { after?.(); toast.success(success); }
    }).catch(error => {
      if (stillCurrent()) toast.error("Couldn't update workspace sharing", { description: error instanceof Error ? error.message : "Try again." });
    }).finally(() => { if (stillCurrent()) setBusy(false); });
  };
  const refresh = () => {
    void Promise.allSettled([refreshCloudWorkspace(target), cloudWorkspaceCollaboration.load(key, true)]);
  };
  const data = read.data;
  const changed = data !== undefined && data.accessRevision !== workspace.accessRevision;
  const disabled = busy || changed || read.error !== null;
  const noWriterSlot = data?.writers?.available === 0;
  const loadMore = (collection: CloudWorkspaceCollaboratorCollection) => {
    setBusy(true);
    void cloudWorkspaceCollaboration.loadMore(key, collection).catch(error => {
      if (stillCurrent()) toast.error("Couldn't load collaborators", { description: error instanceof Error ? error.message : "Try again." });
    }).finally(() => { if (stillCurrent()) setBusy(false); });
  };
  const label = (userId: string, displayName?: string | null) => userId === owner.accountId ? "You" : displayName?.trim() || `Member ${userId.slice(0, 8)}`;
  const roleControl = (userId: string, role: CloudWorkspaceActorRole | null, displayName?: string | null) => {
    if (!data?.writers || !role || role === "owner" || role === "manager")
      return <span className="text-fg3 text-xs">{role ? ROLE_LABELS[role] : "Unavailable"}</span>;
    return (
      <Select value={role} disabled={disabled} onValueChange={value => run(() => setCloudWorkspaceCollaboratorRole(target, userId, value as "viewer" | "developer"), "Collaborator role updated")}>
        <SelectTrigger aria-label={`Role for ${label(userId, displayName)}`}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="viewer">Viewer</SelectItem>
          {role === "prompter" && <SelectItem value="prompter" disabled>Prompter</SelectItem>}
          <SelectItem value="developer" disabled={noWriterSlot && role === "viewer"}>Developer</SelectItem>
        </SelectContent>
      </Select>
    );
  };
  return (
    <div className="space-y-3" aria-label="Manage workspace sharing" aria-busy={busy}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-fg3 text-xs">{data?.writers ? `${data.writers.used} / ${data.writers.limit} writer slots used` : data ? "Organization-funded sharing" : "Loading collaborators…"}</p>
        <Button size="sm" variant="ghost" disabled={busy} onClick={refresh} aria-label="Refresh collaborators"><RefreshCw size={14} /></Button>
      </div>
      {read.error && <p className="text-red-primary text-xs" role="alert">{read.error.message}</p>}
      {changed && <p className="text-fg3 text-xs" role="status">Sharing changed. Refresh to use the latest settings.</p>}
      {data && (
        <>
          <Select value={workspace.sharingMode} disabled={disabled} onValueChange={value => run(
            () => setCloudWorkspaceSharing(target, value as "private" | "organization", workspace.accessRevision!), "Sharing updated")}>
            <SelectTrigger aria-label="Workspace sharing scope"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="organization">Organization</SelectItem><SelectItem value="private">Private</SelectItem></SelectContent>
          </Select>
          <p className="text-fg3 text-xs">{data.writers
            ? "Private keeps the owner and explicitly assigned collaborators. Organization members retain viewer access while shared."
            : "Existing organization-funded access rules apply. The listed roles reflect current workspace authority."}</p>
          {workspace.sharingMode === "private" && <>
            <p className="text-fg3 text-xs">For an owner-only workspace, enable collaboration before inviting. The scope stays private.</p>
            <Button size="sm" disabled={disabled} onClick={() => run(
              () => setCloudWorkspaceSharing(target, "private", workspace.accessRevision!), "Collaboration enabled")}>
              Enable collaboration
            </Button>
          </>}
          <form className="space-y-2" onSubmit={event => {
            event.preventDefault();
            if (!email.trim() || disabled || invitationRole !== "viewer" && noWriterSlot) return;
            if (invitation.current?.email !== email.trim() || invitation.current.role !== invitationRole)
              invitation.current = { email: email.trim(), role: invitationRole, key: crypto.randomUUID() };
            run(() => inviteCloudWorkspaceCollaborator(target, email.trim(), invitationRole, invitation.current!.key), "Invitation sent", () => {
              setEmail(""); invitation.current = null;
            });
          }}>
            <Input aria-label="Collaborator email" type="email" placeholder="Email address" value={email} maxLength={254} disabled={disabled} onChange={event => setEmail(event.target.value)} />
            <div className="flex items-center gap-2">
              <Select value={invitationRole} disabled={disabled} onValueChange={value => setInvitationRole(value as CloudWorkspaceInvitationRole)}>
                <SelectTrigger aria-label="Invitation role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem><SelectItem value="prompter" disabled={noWriterSlot}>Prompter</SelectItem>
                  <SelectItem value="developer" disabled={noWriterSlot}>Developer</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" type="submit" disabled={disabled || !email.trim() || invitationRole !== "viewer" && noWriterSlot}>Invite</Button>
            </div>
          </form>
          {noWriterSlot && <p className="text-fg3 text-xs">All writer slots are in use. Invite a viewer or downgrade a writer first.</p>}
          <div className="max-h-60 space-y-3 overflow-y-auto" aria-label="Collaborator lists">
            <div className="space-y-2">
              <h3 className="text-fg2 text-xs font-medium">Organization members</h3>
              {data.members.filter(member => !data.guests.some(guest => guest.userId === member.userId)).map(member => (
                <div key={member.userId} className="flex items-center gap-2">
                  <span className="text-fg1 min-w-0 flex-1 truncate text-xs" title={label(member.userId, member.displayName)}>{label(member.userId, member.displayName)}</span>
                  {roleControl(member.userId, member.role, member.displayName)}
                  {data.writers && member.role && !["owner", "manager"].includes(member.role) && <Button size="icon-sm" variant="ghost" disabled={disabled}
                    aria-label={`Remove assignment for ${label(member.userId, member.displayName)}`} onClick={() => run(() => revokeCloudWorkspaceCollaborator(target, member.userId), "Collaborator assignment removed")}><Trash2 size={14} /></Button>}
                </div>
              ))}
              {data.memberCursor && <Button size="sm" disabled={disabled || read.refreshing} onClick={() => loadMore("members")}>More members</Button>}
            </div>
            <div className="space-y-2">
              <h3 className="text-fg2 text-xs font-medium">Guests</h3>
              {data.guests.length === 0 && <p className="text-fg3 text-xs">No guest access.</p>}
              {data.guests.map(guest => <div key={guest.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1"><p className="text-fg1 truncate text-xs" title={label(guest.userId, guest.displayName)}>{label(guest.userId, guest.displayName)}</p>
                  <p className="text-fg3 text-xs">Expires {new Date(guest.expiresAt).toLocaleDateString()}</p></div>
                {roleControl(guest.userId, guest.role, guest.displayName)}
                <Button size="icon-sm" variant="ghost" disabled={disabled} aria-label={`Remove guest access for ${label(guest.userId, guest.displayName)}`}
                  onClick={() => run(() => revokeCloudWorkspaceCollaborator(target, guest.userId), "Guest access removed")}><Trash2 size={14} /></Button>
              </div>)}
              {data.guestCursor && <Button size="sm" disabled={disabled || read.refreshing} onClick={() => loadMore("guests")}>More guests</Button>}
            </div>
            <div className="space-y-2">
              <h3 className="text-fg2 text-xs font-medium">Pending invitations</h3>
              {data.invitations.length === 0 && <p className="text-fg3 text-xs">No pending invitations.</p>}
              {data.invitations.map(item => <div key={item.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1"><p className="text-fg1 text-xs">{ROLE_LABELS[item.role]} invitation · {item.id.slice(0, 8)}</p>
                  <p className="text-fg3 text-xs">Expires {new Date(item.expiresAt).toLocaleDateString()} · {item.deliveryState === "dead" ? "Delivery failed" : item.deliveryState}</p></div>
                <Button size="sm" disabled={disabled} onClick={() => run(() => revokeCloudWorkspaceInvitation(target, item.id), "Invitation cancelled")}>Cancel invitation</Button>
              </div>)}
              {data.invitationCursor && <Button size="sm" disabled={disabled || read.refreshing} onClick={() => loadMore("invitations")}>More invitations</Button>}
            </div>
          </div>
          {busy && <p className="text-fg3 text-xs" role="status">Updating sharing…</p>}
        </>
      )}
    </div>
  );
}
