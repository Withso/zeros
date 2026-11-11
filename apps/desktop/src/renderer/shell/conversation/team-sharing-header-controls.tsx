import { Pin, PinOff } from "lucide-react";
import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from "@/renderer/shared/ui/primitives/avatar";
import { Button } from "@/renderer/shared/ui/primitives/button";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { Tooltip } from "@/renderer/shared/ui/primitives/tooltip";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { initialsOf } from "@/renderer/shared/lib/initials";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { CloudWorkspaceTarget } from "../../platform/bridge/cloud-workspace-key";
import { useMyUserId } from "../../platform/team-sharing-state";
import { useDocumentActive } from "../../state/use-document-active";
import { useCloudWorkspaceEvents } from "../../state/use-cloud-workspace-events";
import { useOrganizationRoster } from "../../state/organization-roster";
import { setCloudWorkspaceSharingFlag } from "../../state/team-sharing-actions";

const MAX_FACES = 3;

/** Team sharing in a shared workspace's header: who else is looking, Follow
 * (not for its Creator) and Pin. Holds the workspace's events stream while the
 * workspace is the active, visible surface. */
export function TeamSharingHeaderControls({ target, workspace, active }: {
  target: CloudWorkspaceTarget;
  workspace: CloudWorkspaceDocument;
  active: boolean;
}) {
  const sharing = workspace.sharing!;
  const visible = useDocumentActive(active);
  const me = useMyUserId();
  // A reader's only live source; the Creator's worker connection already carries content, so it gets presence only.
  const presence = useCloudWorkspaceEvents(target, visible, sharing.readOnly);
  const roster = useOrganizationRoster(target.organizationId, visible);
  const others = (presence?.userIds ?? []).filter(id => id !== me);
  const faces = others.slice(0, MAX_FACES).map(id => roster?.find(member => member.id === id) ?? { id, name: "A teammate", avatarUrl: null });
  const extra = Math.max(0, (presence ? presence.total - (presence.userIds.includes(me ?? "") ? 1 : 0) : 0) - faces.length);
  const names = [...faces.map(face => face.name), ...(extra ? [`${extra} more`] : [])].join(", ");
  const toggle = (field: "following" | "pinned", value: boolean, failure: string) => {
    void setCloudWorkspaceSharingFlag(target, field, value).catch(() => toast.error(failure, { description: "Try again." }));
  };
  return (
    <div className="flex shrink-0 items-center gap-1" data-team-sharing-header="">
      {faces.length > 0 && (
        <Tooltip label={`Also here: ${names}`}>
          <AvatarGroup className="mr-1" role="img" aria-label={`Also viewing: ${names}`} data-team-sharing-presence="">
            {faces.map(face => (
              <Avatar key={face.id} size="xs">
                {face.avatarUrl && <AvatarImage src={face.avatarUrl} alt="" referrerPolicy="no-referrer" />}
                <AvatarFallback>{initialsOf(face.name)}</AvatarFallback>
              </Avatar>
            ))}
            {extra > 0 && <span className="text-fg3 text-3xxs relative pl-2.5 leading-5 tabular-nums">{`+${extra}`}</span>}
          </AvatarGroup>
        </Tooltip>
      )}
      {sharing.viewerRole !== "creator" && (
        <Button size="compact" variant="ghost" aria-pressed={sharing.following}
          onClick={() => toggle("following", !sharing.following, sharing.following ? "Couldn't unfollow workspace" : "Couldn't follow workspace")}>
          {sharing.following ? "Following" : "Follow"}
        </Button>
      )}
      <Tooltip label={sharing.pinned ? "Unpin workspace" : "Pin workspace"}>
        <IconButton size="compact" label={sharing.pinned ? "Unpin workspace" : "Pin workspace"} aria-pressed={sharing.pinned}
          onClick={() => toggle("pinned", !sharing.pinned, sharing.pinned ? "Couldn't unpin workspace" : "Couldn't pin workspace")}>
          {sharing.pinned ? <PinOff /> : <Pin />}
        </IconButton>
      </Tooltip>
    </div>
  );
}
