import { useCloudFolderTeamWriting } from "../../state/cloud-workspace-creators";

/** Wire decision 13: in a shared workspace everyone's turns run on one VM, so
 * a person's agent login and personal secrets are readable by its members
 * while their turn runs. Said plainly under the composer, nowhere else. */
export const TEAM_WRITING_NOTICE = "Shared workspace: while your turn runs, its members can read the agent login and personal secrets it uses.";

export function TeamWritingNotice({ folder }: { folder: string | null | undefined }) {
  return useCloudFolderTeamWriting(folder) ? <TeamWritingNoticeText /> : null;
}

export function TeamWritingNoticeText() {
  return <p className="text-fg3 px-1 text-xs" data-team-writing-notice="">{TEAM_WRITING_NOTICE}</p>;
}
