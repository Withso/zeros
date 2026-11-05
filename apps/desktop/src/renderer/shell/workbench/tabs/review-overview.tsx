// ──────────────────────────────────────────────────────────
// Review Overview — the header rows, sub-tabs and the Overview body
// ──────────────────────────────────────────────────────────
//
// The pull request reads top down: its header in rows, then Overview's Git
// status (the branch on this machine), PR status (the pull request on the
// host, with the one Merge) and Findings (agents, review apps and code
// scanning), with the rail beside them (docs/design-implementation/plans.md
// §1). Below the rail's container width it folds into Details after PR status.

import React, { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronDown,
  CircleCheck,
  CircleDot,
  CircleX,
  Copy,
  ExternalLink,
  FileDiff,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  MoreHorizontal,
  ScanSearch,
} from "lucide-react";

import type { PR, PrLabel, PrPerson, PrTimelineItem } from "../../../platform/git";
import {
  Button,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
} from "@/renderer/shared/ui/primitives";
import { SplitButton } from "@/renderer/shared/ui/primitives/split-button";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { cn } from "@/renderer/shared/ui/cn";
import { AgentIcon } from "@/renderer/features/agent/agent-icon";
import { STATUS_CARD } from "../../pr/git-status-card";
import type { ReviewMergeMethod, ReviewProvider } from "../../pr/review-provider";
import { AGENT_WORKING_REASON } from "../../pr/use-agent-working";
import type { ReviewSubtab } from "../tab-model";
import { AuthorAvatar, OutcomeGlyph } from "./review-shared-components";
import {
  latestReviewsByAuthor,
  relTime,
  reviewActionBlockReason,
  type ChecksSummary,
  type PrStatusView,
  type ReviewFinding,
} from "./review-model";

// ── merge method memory ─────────────────────────────────────

function mergeMethodKey(provider: ReviewProvider): string {
  return `zeros.review.merge-method.${provider.cacheKey}`;
}

export function loadMergeMethod(provider: ReviewProvider): ReviewMergeMethod {
  const fallback = provider.capabilities.mergeMethods[0]?.id ?? "squash";
  try {
    const saved = window.localStorage.getItem(mergeMethodKey(provider));
    return provider.capabilities.mergeMethods.some((method) => method.id === saved)
      ? (saved as ReviewMergeMethod)
      : fallback;
  } catch {
    return fallback;
  }
}

export function saveMergeMethod(provider: ReviewProvider, method: ReviewMergeMethod): void {
  try {
    window.localStorage.setItem(mergeMethodKey(provider), method);
  } catch {
    // Storage is a convenience; the method still applies to this merge.
  }
}

// ── header ──────────────────────────────────────────────────

const STATE_CHIP: Record<PR["state"], { label: string; icon: typeof GitPullRequest; className: string }> = {
  draft: { label: "Draft", icon: GitPullRequestDraft, className: "bg-bg2 text-fg2" },
  ready: { label: "Open", icon: GitPullRequest, className: "bg-green-bg text-green-fg" },
  merged: { label: "Merged", icon: GitMerge, className: "bg-violet-bg text-violet-fg" },
  closed: { label: "Closed", icon: GitPullRequestClosed, className: "bg-red-bg text-red-fg" },
};

export interface ReviewChangeCounts {
  files: number;
  additions: number;
  deletions: number;
}

function copy(text: string, what: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`Copied ${what}`))
    .catch(() => toast.error(`Couldn’t copy the ${what}`));
}

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inline-flex shrink-0 gap-1 tabular-nums">
      <span className="text-green-primary">+{additions}</span>
      <span className="text-red-primary">−{deletions}</span>
    </span>
  );
}

function BranchChip({ children, title, shrink }: { children: string; title: string; shrink?: boolean }) {
  return (
    <span
      title={title}
      className={cn(
        "bg-bg2 text-fg2 text-3xxs inline-flex h-6 min-w-0 items-center rounded-full px-2.5 leading-4",
        shrink ? "shrink" : "shrink-0",
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

/** State; repo and number; title; author and branches; age and size. Only
 * Open on the host and More stay in the header: Merge, Ready for review and
 * Archive live in PR status. */
export function ReviewHeader({
  pr,
  repoSlug,
  hostLabel,
  prUrl,
  changes,
  onRefresh,
}: {
  pr: PR;
  repoSlug: string | null;
  hostLabel: string;
  prUrl: string | null;
  changes: ReviewChangeCounts | null;
  onRefresh: () => void;
}) {
  const chip = STATE_CHIP[pr.state];
  const StateIcon = chip.icon;
  const url = prUrl ?? pr.url;
  const age =
    pr.state === "merged" && pr.mergedAt
      ? `Merged ${relTime(pr.mergedAt)}`
      : pr.state === "closed"
        ? `Closed ${relTime(pr.updatedAt)}`
        : `Opened ${relTime(pr.createdAt)}`;
  return (
    <header data-review-header="" className="flex shrink-0 flex-col px-5 pt-4 pb-3.5">
      <div className="flex min-h-7 min-w-0 items-center gap-0.5">
        <span
          data-review-state={pr.state}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs leading-4.5 font-medium [&_svg]:size-3.5",
            chip.className,
          )}
        >
          <StateIcon aria-hidden />
          {chip.label}
        </span>
        <span className="flex-1" />
        {url ? (
          <IconButton size="standard" label={`Open pull request #${pr.number} on ${hostLabel}`} asChild>
            <a href={url} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden />
            </a>
          </IconButton>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="standard" label="More pull request actions">
              <MoreHorizontal aria-hidden />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {url ? <DropdownMenuItem onSelect={() => copy(url, "link")}>Copy link</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={() => copy(pr.headBranch, "branch name")}>Copy branch name</DropdownMenuItem>
            <DropdownMenuItem onSelect={onRefresh}>Refresh</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-fg3 m-0 mt-3 text-xs tabular-nums">
        {repoSlug ? `${repoSlug} · ` : ""}#{pr.number}
      </p>
      <h2 className="text-fg1 m-0 mt-0.5 text-lg leading-7 font-semibold [overflow-wrap:anywhere]">{pr.title}</h2>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-fg2 inline-flex min-w-0 items-center gap-2 text-xs">
          <AuthorAvatar login={pr.authorLogin} avatarUrl={pr.authorAvatarUrl ?? null} />
          <span className="truncate">{pr.authorLogin}</span>
        </span>
        <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
          <BranchChip title="Base branch">{pr.baseBranch}</BranchChip>
          <ArrowLeft aria-label="from" className="text-fg3 size-3.5 shrink-0" />
          <BranchChip title={pr.headBranch} shrink>
            {pr.headBranch}
          </BranchChip>
          <IconButton size="compact" label={`Copy ${pr.headBranch}`} onClick={() => copy(pr.headBranch, "branch name")}>
            <Copy aria-hidden />
          </IconButton>
        </span>
      </div>
      <p className="text-fg3 m-0 mt-2.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        <span>{age}</span>
        {changes ? (
          <>
            <span aria-hidden>·</span>
            <span>{changes.files === 1 ? "1 file" : `${changes.files} files`}</span>
            <span className="ml-1">
              <DiffStat additions={changes.additions} deletions={changes.deletions} />
            </span>
          </>
        ) : null}
      </p>
    </header>
  );
}

// ── sub-tabs ────────────────────────────────────────────────

/** Overview, Description, Activity, Checks and Commits: the workbench's 28px
 * chrome pills. The published diff ("changes") is reached from Overview, so
 * Overview stays selected over it. */
export function ReviewSubnav({
  sub,
  onSubChange,
  activityCount,
  commitsCount,
  checksCount,
  checks,
}: {
  sub: ReviewSubtab;
  onSubChange: (sub: ReviewSubtab) => void;
  activityCount: number | null;
  commitsCount: number | null;
  checksCount: number | null;
  checks: ChecksSummary;
}) {
  const count = (n: number | null) =>
    n != null && n > 0 ? <span className="text-fg3 font-normal tabular-nums">{n}</span> : null;
  return (
    <Tabs value={sub === "changes" ? "overview" : sub} onValueChange={(next) => onSubChange(next as ReviewSubtab)}>
      <TabsList
        variant="chrome"
        aria-label="Pull request sections"
        className="border-border1 flex h-auto w-full shrink-0 border-b px-4 pt-0 pb-2"
      >
        <TabsTrigger variant="chrome" value="overview" className="font-medium">
          Overview
        </TabsTrigger>
        <TabsTrigger variant="chrome" value="description" className="font-medium">
          Description
        </TabsTrigger>
        <TabsTrigger variant="chrome" value="activity" className="font-medium">
          Activity
          {count(activityCount)}
        </TabsTrigger>
        <TabsTrigger variant="chrome" value="checks" className="font-medium">
          {checks.tone !== "none" ? (
            <OutcomeGlyph
              outcome={checks.tone === "failure" ? "failed" : checks.tone === "pending" ? "pending" : "passed"}
            />
          ) : null}
          Checks
          {count(checksCount)}
        </TabsTrigger>
        <TabsTrigger variant="chrome" value="commits" className="font-medium">
          Commits
          {count(commitsCount)}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

// ── shared card recipe ──────────────────────────────────────

/** Overview's card (git-status-card.tsx owns it); rows divide with border1. */
const REVIEW_CARD = STATUS_CARD;
const ROW = "border-border1 flex min-h-11 min-w-0 items-center gap-2.5 py-1.5 pr-2.5 pl-3.5 [&+&]:border-t";
const ROW_HEAD = "min-h-13 py-2.5";

export function ReviewSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2">
      <div className="text-fg1 flex min-h-7 min-w-0 items-center gap-1.5 text-xs font-medium">
        <span>{title}</span>
        {count != null && count > 0 ? <span className="text-fg3 font-normal tabular-nums">{count}</span> : null}
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

// ── PR status ───────────────────────────────────────────────

const VERDICT_ICON: Record<PrStatusView["tone"], { icon: typeof CircleCheck; className: string }> = {
  success: { icon: CircleCheck, className: "text-green-primary" },
  danger: { icon: CircleX, className: "text-red-primary" },
  neutral: { icon: CircleDot, className: "text-fg3" },
  merged: { icon: GitMerge, className: "text-violet-fg" },
  closed: { icon: GitPullRequestClosed, className: "text-red-fg" },
};

const BLOCKER_ICON: Record<string, { icon: typeof CircleX; className: string }> = {
  check: { icon: CircleX, className: "text-red-primary" },
  review: { icon: FileDiff, className: "text-red-primary" },
  conflicts: { icon: GitMerge, className: "text-yellow-icon" },
  behind: { icon: ArrowLeft, className: "text-fg3" },
  requirements: { icon: CircleDot, className: "text-fg3" },
};

/** The pull request on the host: the verdict, the one action, only what blocks
 * it with Add to chat, and what is done. Merge is green when it can run and a
 * quiet outline when it can't; the island's state decides which. */
export function PrStatusCard({
  view,
  provider,
  islandKind,
  agentWorking,
  busy,
  onMerge,
  onMarkReady,
  onAddToChat,
}: {
  view: PrStatusView;
  provider: ReviewProvider;
  islandKind: string | null;
  agentWorking: boolean;
  busy: boolean;
  onMerge: (method: ReviewMergeMethod) => void;
  onMarkReady: () => void;
  onAddToChat: (text: string) => void;
}) {
  const Verdict = VERDICT_ICON[view.tone];
  return (
    <div data-review-pr-status="" className={REVIEW_CARD}>
      <div className={cn(ROW, ROW_HEAD)}>
        <Verdict.icon aria-hidden className={cn("size-4 shrink-0", Verdict.className)} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-fg1 truncate text-xs font-medium">{view.title}</span>
          {view.detail ? <span className="text-fg3 text-3xxs leading-4">{view.detail}</span> : null}
        </div>
        {view.action === "merge" ? (
          <MergeAction
            provider={provider}
            islandKind={islandKind}
            agentWorking={agentWorking}
            busy={busy}
            onMerge={onMerge}
          />
        ) : view.action === "ready" ? (
          <ReadyAction islandKind={islandKind} agentWorking={agentWorking} busy={busy} onMarkReady={onMarkReady} />
        ) : null}
      </div>
      {view.blockers.map((blocker) => {
        const Icon = BLOCKER_ICON[blocker.kind] ?? BLOCKER_ICON.requirements;
        return (
          <div key={blocker.id} data-review-blocker={blocker.kind} className={ROW}>
            <Icon.icon aria-hidden className={cn("size-4 shrink-0", Icon.className)} />
            <span className="text-fg1 min-w-0 flex-1 truncate text-xs">{blocker.title}</span>
            {blocker.chatText ? (
              <Button
                variant="ghost"
                size="compact"
                className="text-fg2"
                onClick={() => onAddToChat(blocker.chatText as string)}
              >
                Add to chat
              </Button>
            ) : null}
          </div>
        );
      })}
      {view.done ? (
        <div className={cn(ROW, "min-h-9 py-2")}>
          <CircleCheck aria-hidden className="text-fg3 mx-px size-3.5 shrink-0" />
          <span className="text-fg3 text-3xxs min-w-0 flex-1 leading-4">{view.done}</span>
        </div>
      ) : null}
    </div>
  );
}

function blockedTooltip(node: React.ReactElement, reason: string | null) {
  return reason ? (
    <Tooltip label={reason}>
      {/* The span keeps the tooltip live over the disabled control. */}
      <span className="inline-flex shrink-0">{node}</span>
    </Tooltip>
  ) : (
    node
  );
}

function MergeAction({
  provider,
  islandKind,
  agentWorking,
  busy,
  onMerge,
}: {
  provider: ReviewProvider;
  islandKind: string | null;
  agentWorking: boolean;
  busy: boolean;
  onMerge: (method: ReviewMergeMethod) => void;
}) {
  const methods = provider.capabilities.mergeMethods;
  const [method, setMethod] = useState<ReviewMergeMethod>(() => loadMergeMethod(provider));
  const selected = methods.find((candidate) => candidate.id === method) ?? methods[0];
  if (!selected) return null;
  const reason = reviewActionBlockReason(islandKind, "merge") ?? (agentWorking ? AGENT_WORKING_REASON : null);
  return blockedTooltip(
    <SplitButton
      variant={reason ? "secondary" : "merge"}
      disabled={!!reason}
      menuDisabled={busy}
      loading={busy}
      onClick={() => onMerge(selected.id)}
      menuLabel="Choose merge method"
      menu={
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={selected.id}
            onValueChange={(next) => {
              setMethod(next as ReviewMergeMethod);
              saveMergeMethod(provider, next as ReviewMergeMethod);
            }}
          >
            {methods.map((candidate) => (
              <DropdownMenuRadioItem key={candidate.id} value={candidate.id}>
                {candidate.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      }
    >
      {selected.label}
    </SplitButton>,
    reason,
  );
}

function ReadyAction({
  islandKind,
  agentWorking,
  busy,
  onMarkReady,
}: {
  islandKind: string | null;
  agentWorking: boolean;
  busy: boolean;
  onMarkReady: () => void;
}) {
  const reason = reviewActionBlockReason(islandKind, "ready") ?? (agentWorking ? AGENT_WORKING_REASON : null);
  return blockedTooltip(
    <Button variant="primary" disabled={!!reason} loading={busy} onClick={onMarkReady}>
      Ready for review
    </Button>,
    reason,
  );
}

// ── Findings ────────────────────────────────────────────────

/** A finding's one line with its `code` spans set as code. */
function FindingTitle({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 && index < parts.length - 1 ? (
          <code key={index} className="bg-bg2 text-fg1 text-3xxs rounded-sm px-1 py-px font-mono leading-4">
            {part}
          </code>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

function FindingMark({ finding }: { finding: ReviewFinding }) {
  if (finding.author.kind === "agent") {
    return (
      <span aria-hidden className="bg-bg2 inline-flex size-5 shrink-0 items-center justify-center rounded-sm">
        <AgentIcon agentId={finding.author.provider ?? null} iconUrl={null} size={12} />
      </span>
    );
  }
  const Icon = finding.author.kind === "check" ? ScanSearch : Bot;
  return (
    <span aria-hidden className="bg-bg2 text-fg2 inline-flex size-5 shrink-0 items-center justify-center rounded-sm [&_svg]:size-3">
      <Icon />
    </span>
  );
}

/** Comments from agents, review apps and code scanning: what it says, then who
 * and where. Each has Add to chat; resolved ones fold under Show resolved. */
export function FindingsSection({
  findings,
  onAddToChat,
}: {
  findings: readonly ReviewFinding[];
  onAddToChat: (text: string) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const open = findings.filter((finding) => !finding.resolved);
  const resolved = findings.filter((finding) => finding.resolved);
  if (findings.length === 0) return null;
  return (
    <ReviewSection
      title="Findings"
      count={open.length}
      action={
        open.length > 1 ? (
          <Button variant="secondary" size="compact" onClick={() => onAddToChat(open.map((f) => f.chatText).join(""))}>
            Add all to chat
          </Button>
        ) : null
      }
    >
      <div data-review-findings="" className={REVIEW_CARD}>
        {[...open, ...(showResolved ? resolved : [])].map((finding) => (
          <div key={finding.key} data-review-finding={finding.author.kind} className={cn(ROW, "min-h-13")}>
            <FindingMark finding={finding} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={cn("truncate text-xs", finding.resolved ? "text-fg3" : "text-fg1")}>
                <FindingTitle text={finding.title} />
              </span>
              <span className="text-fg3 text-3xxs truncate leading-4">
                {finding.author.name} · <span className="font-mono text-2xxs">{finding.location}</span>
              </span>
            </div>
            {finding.resolved ? (
              <span className="text-fg3 text-3xxs shrink-0 leading-4">Resolved</span>
            ) : (
              <Button variant="ghost" size="compact" className="text-fg2" onClick={() => onAddToChat(finding.chatText)}>
                Add to chat
              </Button>
            )}
          </div>
        ))}
        {resolved.length > 0 ? (
          <div className={cn(ROW, "min-h-9 py-1.5")}>
            <Button
              variant="ghost"
              size="compact"
              className="text-fg3 -ml-1.5"
              aria-expanded={showResolved}
              onClick={() => setShowResolved((value) => !value)}
            >
              <ChevronDown aria-hidden className={cn("transition-transform", showResolved && "rotate-180")} />
              {showResolved ? "Hide resolved" : `Show ${resolved.length} resolved`}
            </Button>
          </div>
        ) : null}
      </div>
    </ReviewSection>
  );
}

// ── rail ────────────────────────────────────────────────────

const REVIEW_STATE_ICON: Record<string, { icon: typeof CircleCheck; className: string; label: string }> = {
  APPROVED: { icon: CircleCheck, className: "text-green-primary", label: "Approved" },
  CHANGES_REQUESTED: { icon: FileDiff, className: "text-red-primary", label: "Requested changes" },
  COMMENTED: { icon: MessageSquare, className: "text-fg3", label: "Commented" },
  DISMISSED: { icon: CircleDot, className: "text-fg3", label: "Dismissed" },
};

function RailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-1.5">
      <span className="text-fg3 text-3xxs leading-4 font-medium">{title}</span>
      {children}
    </section>
  );
}

function PersonRow({ person, trailing }: { person: PrPerson; trailing?: React.ReactNode }) {
  return (
    <div className="text-fg1 flex min-h-6 min-w-0 items-center gap-2 text-xs">
      <AuthorAvatar login={person.login} avatarUrl={person.avatarUrl} />
      <span className="min-w-0 flex-1 truncate">{person.login}</span>
      {trailing}
    </div>
  );
}

function linkedIssues(body: string): number[] {
  const found = new Set<number>();
  for (const match of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)) {
    found.add(Number(match[1]));
  }
  return [...found];
}

/** Reviewers with their verdicts, assignees, labels, the linked issue and the
 * change counts with Open changes. A section with nothing to show is left out;
 * Changes always shows. */
export function ReviewRail({
  pr,
  timeline,
  changes,
  onOpenChanges,
}: {
  pr: PR;
  timeline: readonly PrTimelineItem[] | null;
  changes: ReviewChangeCounts | null;
  onOpenChanges: () => void;
}) {
  const reviewers = useMemo(() => {
    const standing = latestReviewsByAuthor(timeline ?? []).filter((review) => review.author !== pr.authorLogin);
    const seen = new Set(standing.map((review) => review.author));
    const requested = (pr.requestedReviewers ?? []).filter((person) => !seen.has(person.login));
    return [
      ...requested.map((person) => ({ person, state: null as string | null })),
      ...standing.map((review) => ({
        person: { login: review.author, avatarUrl: review.authorAvatarUrl },
        state: review.state,
      })),
    ];
  }, [timeline, pr.authorLogin, pr.requestedReviewers]);
  const issues = useMemo(() => linkedIssues(pr.body), [pr.body]);
  const repoUrl = pr.url.replace(/\/pull\/\d+.*$/, "");
  const labels: readonly PrLabel[] = pr.labels ?? [];
  return (
    <aside data-review-rail="" className="flex min-w-0 flex-col gap-5">
      {reviewers.length > 0 ? (
        <RailSection title="Reviewers">
          {reviewers.map(({ person, state }) => {
            const mark = state ? REVIEW_STATE_ICON[state] : null;
            return (
              <PersonRow
                key={person.login}
                person={person}
                trailing={
                  mark ? (
                    <mark.icon aria-label={mark.label} className={cn("size-3.5 shrink-0", mark.className)} />
                  ) : (
                    <span className="text-fg3 text-3xxs leading-4">Requested</span>
                  )
                }
              />
            );
          })}
        </RailSection>
      ) : null}
      {pr.assignees && pr.assignees.length > 0 ? (
        <RailSection title="Assignees">
          {pr.assignees.map((person) => (
            <PersonRow key={person.login} person={person} />
          ))}
        </RailSection>
      ) : null}
      {labels.length > 0 ? (
        <RailSection title="Labels">
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {labels.map((label) => (
              <span
                key={label.name}
                className="border-border2 text-fg1 text-3xxs inline-flex h-5 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2 leading-4"
              >
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  // A label's own colour from the host, not a theme colour.
                  style={{ background: label.color ? `#${label.color}` : "var(--fg3)" }}
                />
                <span className="truncate">{label.name}</span>
              </span>
            ))}
          </div>
        </RailSection>
      ) : null}
      {issues.length > 0 ? (
        <RailSection title={issues.length === 1 ? "Linked issue" : "Linked issues"}>
          {issues.map((issue) => (
            <a
              key={issue}
              href={`${repoUrl}/issues/${issue}`}
              target="_blank"
              rel="noreferrer"
              className="text-fg1 hover:text-fg1 inline-flex min-h-6 items-center gap-2 text-xs no-underline"
            >
              <CircleDot aria-hidden className="text-green-primary size-3.5 shrink-0" />
              <span className="text-fg3 tabular-nums">#{issue}</span>
            </a>
          ))}
        </RailSection>
      ) : null}
      <RailSection title="Changes">
        {changes ? (
          <span className="text-fg1 inline-flex items-center gap-1.5 text-xs">
            {changes.files === 1 ? "1 file" : `${changes.files} files`}
            <DiffStat additions={changes.additions} deletions={changes.deletions} />
          </span>
        ) : (
          <span className="text-fg3 text-xs">Counting…</span>
        )}
        <Button variant="ghost" size="compact" className="text-fg2 -ml-1.5 w-fit" onClick={onOpenChanges}>
          Open changes
          <ArrowRight aria-hidden />
        </Button>
      </RailSection>
    </aside>
  );
}

/** Git status, PR status and Findings beside the rail; below the rail's
 * container width the rail follows PR status as Details. */
export function ReviewOverviewLayout({
  gitStatus,
  prStatus,
  findings,
  rail,
}: {
  gitStatus: React.ReactNode;
  prStatus: React.ReactNode;
  findings: React.ReactNode;
  rail: React.ReactNode;
}) {
  return (
    <div className="@container/review">
      <div
        data-review-overview=""
        className="grid min-w-0 grid-cols-1 items-start gap-6 px-5 pt-5 pb-7 @3xl/review:grid-cols-[minmax(0,1fr)_224px] @3xl/review:gap-8"
      >
        <div className="flex min-w-0 flex-col gap-6">
          {gitStatus ? <ReviewSection title="Git status">{gitStatus}</ReviewSection> : null}
          <ReviewSection title="PR status">{prStatus}</ReviewSection>
          <div className="@3xl/review:hidden">
            <ReviewSection title="Details">
              <div className={cn(REVIEW_CARD, "p-3.5")}>{rail}</div>
            </ReviewSection>
          </div>
          {findings}
        </div>
        <div className="hidden @3xl/review:block">{rail}</div>
      </div>
    </div>
  );
}
