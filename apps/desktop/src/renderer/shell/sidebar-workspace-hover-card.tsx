import { useEffect } from "react";
import { Archive, ArrowUpRight, Cloud, FolderOpen, GitPullRequest, GitPullRequestClosed, GitMerge, GitCommitVertical } from "lucide-react";
import { RepositoryIcon } from "../features/repositories/repository-icon";
import { formatCompactAge } from "../features/agent/format-age";
import { useOptionalAgentSessions } from "../features/agent/sessions-hooks";
import { useSessionsStore, useAnyChatWorking } from "../features/agent/sessions-store";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import type { ChangeLineCounts, Workspace } from "../platform/git";
import type { Project } from "../state/projects-store";
import { useWorkspaceStore } from "../state/store";
import { isLocalMainWorkspace } from "../state/local-main-workspace";
import { resolveCardActionKind } from "../shared/lib/workspace-card-action";
import { Button } from "../shared/ui/primitives/button";
import { Tooltip } from "../shared/ui/primitives/tooltip";
import { CreatePrButton } from "./pr/create-pr-button";
import { useWorkspaceHasChanges } from "./pr/use-workspace-has-changes";
import { useSendToChat } from "./pr/use-send-to-active-chat";
import { AGENT_WORKING_REASON } from "./pr/use-agent-working";
import { buildActionPrompt, promptActionBubble } from "./pr/pr-action-prompts";
import { sidebarPreviewChat, sidebarPreviewText, sidebarWorkspaceDisplayId } from "./sidebar-workspace-preview";
import { workspaceLabel } from "./workspace-tabs";
import { isGithubDotComRemote } from "./pr/github-url";
import { parsePrUrl } from "./pr/pr-url-match";

/** Mounted only while the hover surface is visible. The row supplies its
 * confirmed All Changes totals; history joins the existing exact-chat hydrate. */
export function SidebarWorkspaceHoverCard({
  workspace,
  project,
  chatIds,
  changeLines,
  activeAt,
  onSelect,
  onArchive,
  onMenuOpenChange,
}: {
  workspace: Workspace;
  project: Project | null;
  chatIds: readonly string[];
  changeLines: ChangeLineCounts;
  activeAt?: number;
  onSelect: () => void;
  onArchive: () => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const chat = useWorkspaceStore(state => sidebarPreviewChat(workspace, chatIds, state.chats));
  const chatId = chat?.id;
  const sessions = useOptionalAgentSessions();
  const preview = useSessionsStore(state => {
    const slot = chat ? state.sessions[chat.id] : undefined;
    return slot ? sidebarPreviewText(slot.messages) : "";
  });
  useEffect(() => {
    if (chatId && sessions) void sessions.hydrateChat(chatId).catch(() => {});
  }, [chatId, sessions]);
  const cloud = isCloudWorkspace(workspace.path);
  const folder = isLocalMainWorkspace(workspace);
  const github = !project?.originUrl || isGithubDotComRemote(project.originUrl);
  const finished = workspace.prState === "merged" || workspace.prState === "closed";
  const hasChanges = useWorkspaceHasChanges(
    cloud || folder || finished || workspace.present === false ? null : workspace,
    true,
    { probeWithPr: true },
  );
  const working = useAnyChatWorking(chatIds);
  const sendToChat = useSendToChat(workspace.path);
  const action = folder ? null : resolveCardActionKind(workspace, hasChanges);
  const chatTitle = chat?.title.trim();
  const title = chatTitle && chatTitle !== "Untitled" ? chatTitle : workspaceLabel(workspace);
  const repoName = project?.name ?? workspace.repoSlug;
  const at = Math.max(workspace.createdAt, workspace.lastActiveAt ?? 0, activeAt ?? 0, chat?.updatedAt ?? 0);
  const age = formatCompactAge(at);
  const prUrl = workspace.prUrl && parsePrUrl(workspace.prUrl)?.number === workspace.prNumber
    ? workspace.prUrl : null;
  const PrIcon = workspace.prState === "merged" ? GitMerge
    : workspace.prState === "closed" ? GitPullRequestClosed : GitPullRequest;
  const commitAndPush = () => {
    const bubble = promptActionBubble("commit-and-push")!;
    const sent = sendToChat(chat?.id ?? null, {
      text: buildActionPrompt("commit-and-push", { baseBranch: workspace.baseBranch })!,
      displayText: bubble.label,
      autoAction: bubble.autoAction,
    });
    if (sent) onSelect();
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" data-workspace-preview={workspace.id}>
      <div className="text-fg3 flex min-w-0 items-center gap-2 text-xs">
        <span className="shrink-0 font-mono" title={workspace.id}>
          {sidebarWorkspaceDisplayId(workspace)}
        </span>
        {(changeLines.additions > 0 || changeLines.deletions > 0) && (
          <span className="flex shrink-0 gap-1 font-mono tabular-nums" aria-label={`${changeLines.additions} lines added, ${changeLines.deletions} lines removed`}>
            <span className="text-green-primary">+{changeLines.additions}</span>
            <span className="text-red-primary">−{changeLines.deletions}</span>
          </span>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-1.5" title={repoName}>
          {cloud && <Cloud className="size-3.5 shrink-0" aria-label="Cloud workspace" />}
          {project && <RepositoryIcon project={project} className="size-4 shrink-0 rounded-sm" />}
          <span className="truncate">{repoName}</span>
        </span>
      </div>
      <div className="text-fg1 line-clamp-2 break-words text-sm font-medium" title={title}>{title}</div>
      <div className="text-fg3 truncate text-xs" title={preview || workspace.branch}>
        {preview || workspace.branch}
      </div>
      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
        {action === "archive" ? (
          <Button onClick={onArchive} className="bg-violet-bg text-violet-fg hover:bg-violet-bg border-transparent">
            <Archive />Archive
          </Button>
        ) : cloud || folder || !github || action === "recover" ? (
          <Button onClick={onSelect}><FolderOpen />{action === "recover" ? "Recover workspace" : "Open workspace"}</Button>
        ) : workspace.prNumber == null ? (
          <CreatePrButton
            workspace={workspace}
            originUrl={project?.originUrl ?? null}
            chatId={chat?.id ?? null}
            onMenuOpenChange={onMenuOpenChange}
            disabled={working || hasChanges !== true}
            disabledReason={working ? AGENT_WORKING_REASON : "Nothing to PR yet — this branch has no confirmed changes"}
          />
        ) : action === "commit-push" ? (
          <Tooltip label={working ? AGENT_WORKING_REASON : undefined}>
            <span className="inline-flex">
              <Button variant="default" disabled={working} onClick={commitAndPush}>
                <GitCommitVertical />Commit and push
              </Button>
            </span>
          </Tooltip>
        ) : (
          <Button onClick={onSelect}><FolderOpen />Open workspace</Button>
        )}
        {workspace.prNumber != null && prUrl && (
          <Button asChild variant="ghost" className="text-fg3 gap-0.5 px-0" aria-label={`Open PR #${workspace.prNumber}`}>
            <a href={prUrl} target="_blank" rel="noreferrer">
              <PrIcon />#{workspace.prNumber}<ArrowUpRight className="size-3" />
            </a>
          </Button>
        )}
        {age && <time className="text-fg3 ml-auto shrink-0 text-xs tabular-nums" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
          {age === "now" ? age : `${age} ago`}
        </time>}
      </div>
    </div>
  );
}
