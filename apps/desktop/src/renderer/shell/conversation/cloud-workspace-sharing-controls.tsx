import { useEffect, useRef, useState } from "react";
import { Globe, LockKeyhole, Trash2, Users } from "lucide-react";
import { useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
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
import { cloudCatalogGeneration, cloudWorkspaceDetails, refreshCloudWorkspace } from "../../state/cloud-workspace-catalog";
import { getOrganizationStoreGeneration } from "../../features/team/team-store";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { useCachedRead } from "../../state/use-cached-read";
import { Button, Input } from "../../shared/ui";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import { Avatar, AvatarFallback } from "../../shared/ui/primitives/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/primitives/select";
import { toast } from "../../shared/ui/primitives/elements";
import { CloudWorkspacePopover } from "./cloud-workspace-popover";
import { useCloudWorkspaceSurfaceActive } from "./use-cloud-workspace-surface";

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

export function CloudWorkspaceSharePopover({ workspace, active }: { workspace: CloudWorkspaceDocument; active: boolean }) {
  const target = { organizationId: workspace.organizationId, workspaceId: workspace.id };
  const shown = useCloudWorkspaceSurfaceActive(active);
  const account = getOrganizationStoreGeneration(), catalog = cloudCatalogGeneration();
  const owner = JSON.stringify([account, catalog, workspace.organizationId, workspace.id]);
  const alive = useRef(false), surface = useRef({ owner, shown });
  surface.current = { owner, shown };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const warm = () => {
    if (!shown || !canManageCloudWorkspaceSharing(workspace)) return;
    warmCloudWorkspaceCollaboration(target);
    void cloudWorkspaceDetails.load(cloudWorkspaceKey(target), () => refreshCloudWorkspace(target), { maxAgeMs: 10_000 }).then(document => {
      if (alive.current && surface.current.shown && surface.current.owner === owner &&
          account === getOrganizationStoreGeneration() && catalog === cloudCatalogGeneration() && canManageCloudWorkspaceSharing(document))
        warmCloudWorkspaceCollaboration(target);
    }).catch(() => {});
  };
  return <CloudWorkspacePopover workspace={workspace} active={active} label="Share workspace" text="Share" icon={<Users />}
    warm={warm}>
    {shown => <section className="space-y-3" aria-label="Workspace sharing">
      <h2 className="text-fg1 text-sm font-medium">Share</h2>
      {canManageCloudWorkspaceSharing(workspace) ? <CloudWorkspaceSharingManager workspace={workspace} active={shown} /> :
        <div className="space-y-2 text-xs">
          <p className="text-fg2">{workspace.sharingMode === "organization" ? "Organization access" : workspace.sharingMode === "private" ? "Private workspace" : "Sharing unavailable"}</p>
          <p className="text-fg3">{workspace.actorRole ? `${ROLE_LABELS[workspace.actorRole]} · ${ROLE_DESCRIPTION[workspace.actorRole]}` : "Workspace permissions are unavailable."}</p>
        </div>}
    </section>}
  </CloudWorkspacePopover>;
}

/** Mounted only while the cheap management view is visible. Forms are ephemeral
 * and remount for every account/device/workspace owner. */
export function CloudWorkspaceSharingManager({ workspace, active }: { workspace: CloudWorkspaceDocument; active: boolean }) {
  const internal = useCloudWorkspaceAccountAccess(workspace.organizationId);
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
  const person = (name: string) => <>
    <Avatar className="size-6 shrink-0"><AvatarFallback className="text-xs">{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>
    <Tooltip label={name}><span className="text-fg1 min-w-0 flex-1 truncate text-xs">{name}</span></Tooltip>
  </>;
  const roleControl = (userId: string, role: CloudWorkspaceActorRole | null, displayName?: string | null) => {
    if (!data?.writers || !role || role === "owner" || role === "manager")
      return <span className="text-fg3 shrink-0 text-xs">{role ? ROLE_LABELS[role] : "Unavailable"}</span>;
    return (
      <Select value={role} disabled={disabled} onValueChange={value => run(() => setCloudWorkspaceCollaboratorRole(target, userId, value as "viewer" | "developer"), "Collaborator role updated")}>
        <SelectTrigger className="shrink-0" aria-label={`Role for ${label(userId, displayName)}`}><SelectValue /></SelectTrigger>
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
      {!data && !read.error && <p className="text-fg3 text-xs">Loading collaborators…</p>}
      {read.error && <p className="text-red-primary text-xs" role="alert">{read.error.message}</p>}
      {changed && <p className="text-fg3 text-xs" role="status">Sharing changed. Reload to use the latest settings.</p>}
      {(read.error || changed) && <Button size="sm" variant="ghost" disabled={busy} onClick={refresh} aria-label="Reload sharing">Reload</Button>}
      {data && (
        <>
          <form className="flex min-w-0 items-center gap-2" onSubmit={event => {
            event.preventDefault();
            if (!email.trim() || disabled || invitationRole !== "viewer" && noWriterSlot) return;
            if (invitation.current?.email !== email.trim() || invitation.current.role !== invitationRole)
              invitation.current = { email: email.trim(), role: invitationRole, key: crypto.randomUUID() };
            run(() => inviteCloudWorkspaceCollaborator(target, email.trim(), invitationRole, invitation.current!.key), "Invitation sent", () => {
              setEmail(""); invitation.current = null;
            });
          }}>
            <Input className="min-w-0 flex-1" aria-label="Collaborator email" type="email" placeholder="Email address" value={email} maxLength={254} disabled={disabled} onChange={event => setEmail(event.target.value)} />
              <Select value={invitationRole} disabled={disabled} onValueChange={value => setInvitationRole(value as CloudWorkspaceInvitationRole)}>
                <SelectTrigger className="shrink-0" aria-label="Invitation role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem><SelectItem value="prompter" disabled={noWriterSlot}>Prompter</SelectItem>
                  <SelectItem value="developer" disabled={noWriterSlot}>Developer</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" type="submit" className="shrink-0" disabled={disabled || !email.trim() || invitationRole !== "viewer" && noWriterSlot}>Invite</Button>
          </form>
          {noWriterSlot && <p className="text-fg3 text-xs">All writer slots are in use. Invite a viewer or downgrade a writer first.</p>}
          {(data.members.length > 0 || data.guests.length > 0 || data.invitations.length > 0 ||
            data.memberCursor || data.guestCursor || data.invitationCursor) && <div className="space-y-2">
            <h3 className="text-fg2 text-xs font-medium">People with access</h3>
            <div className="max-h-60 space-y-2 overflow-y-auto" aria-label="Collaborator lists">
              {data.members.filter(member => !data.guests.some(guest => guest.userId === member.userId)).map(member => (
                <div key={member.userId} className="flex items-center gap-2">
                  {person(label(member.userId, member.displayName))}
                  {roleControl(member.userId, member.role, member.displayName)}
                  {data.writers && member.role && !["owner", "manager"].includes(member.role) && <Button size="icon-sm" variant="ghost" disabled={disabled}
                    aria-label={`Remove assignment for ${label(member.userId, member.displayName)}`} onClick={() => run(() => revokeCloudWorkspaceCollaborator(target, member.userId), "Collaborator assignment removed")}><Trash2 size={14} /></Button>}
                </div>
              ))}
              {data.memberCursor && <Button size="sm" disabled={disabled || read.refreshing} onClick={() => loadMore("members")}>More members</Button>}
              {data.guests.map(guest => <div key={guest.id} className="flex items-center gap-2">
                <Avatar className="size-6 shrink-0"><AvatarFallback className="text-xs">{label(guest.userId, guest.displayName).slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>
                <div className="min-w-0 flex-1"><Tooltip label={label(guest.userId, guest.displayName)}><p className="text-fg1 truncate text-xs">{label(guest.userId, guest.displayName)}</p></Tooltip>
                  <p className="text-fg3 text-xs">Expires {new Date(guest.expiresAt).toLocaleDateString()}</p></div>
                {roleControl(guest.userId, guest.role, guest.displayName)}
                <Button size="icon-sm" variant="ghost" disabled={disabled} aria-label={`Remove guest access for ${label(guest.userId, guest.displayName)}`}
                  onClick={() => run(() => revokeCloudWorkspaceCollaborator(target, guest.userId), "Guest access removed")}><Trash2 size={14} /></Button>
              </div>)}
              {data.guestCursor && <Button size="sm" disabled={disabled || read.refreshing} onClick={() => loadMore("guests")}>More guests</Button>}
              {data.invitations.map(item => <div key={item.id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1"><p className="text-fg1 truncate text-xs">Invitation · {item.id.slice(0, 8)}</p>
                  <p className="text-fg3 text-xs">Expires {new Date(item.expiresAt).toLocaleDateString()} · {item.deliveryState === "dead" ? "Delivery failed" : item.deliveryState}</p></div>
                <span className="text-fg3 shrink-0 text-xs">{ROLE_LABELS[item.role]}</span>
                <Button size="sm" disabled={disabled} onClick={() => run(() => revokeCloudWorkspaceInvitation(target, item.id), "Invitation cancelled")}>Cancel invitation</Button>
              </div>)}
              {data.invitationCursor && <Button size="sm" disabled={disabled || read.refreshing} onClick={() => loadMore("invitations")}>More invitations</Button>}
            </div>
          </div>}
          <div className="border-border1 space-y-2 border-t pt-3">
            <h3 className="text-fg2 text-xs font-medium">General access</h3>
            <div className="flex items-center gap-2">
              {workspace.sharingMode === "organization" ? <Globe className="text-fg3 size-4 shrink-0" /> : <LockKeyhole className="text-fg3 size-4 shrink-0" />}
              <Select value={workspace.sharingMode} disabled={disabled} onValueChange={value => run(
                () => setCloudWorkspaceSharing(target, value as "private" | "organization", workspace.accessRevision!), "Sharing updated")}>
                <SelectTrigger aria-label="Workspace sharing scope"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="organization">Organization</SelectItem><SelectItem value="private">Private</SelectItem></SelectContent>
              </Select>
              <span className="text-fg3 ml-auto text-xs">{workspace.sharingMode === "organization" && data.writers ? "Viewer" : "Assigned roles"}</span>
            </div>
            {workspace.sharingMode === "private" && <Button size="sm" disabled={disabled} onClick={() => run(
              () => setCloudWorkspaceSharing(target, "private", workspace.accessRevision!), "Collaboration enabled")}>
              Enable collaboration
            </Button>}
          </div>
          {data.writers && <p className="text-fg3 text-xxs">{data.writers.used} / {data.writers.limit} writer slots used</p>}
          {busy && <p className="text-fg3 text-xs" role="status">Updating sharing…</p>}
        </>
      )}
    </div>
  );
}
