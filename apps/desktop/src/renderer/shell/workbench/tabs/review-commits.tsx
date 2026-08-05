// ──────────────────────────────────────────────────────────
// ReviewCommitsSection — the Review tab's Commits sub-tab
// ──────────────────────────────────────────────────────────
//
// The PR's commits (GitHub's list — authoritative even when the local branch
// is behind) under recency buckets (Today / Yesterday / Last 7 days / Last 30
// days / month), newest first. Rows are summaries only — author(s), file
// count, age, ±stats, sha. The diff itself lives in the Changes tab, so
// nothing here reads the object store.

import React, { useMemo } from "react";

import type { PrCommitSummary } from "../../../platform/git";
import {
  commitAuthorsLabel,
  groupCommitsByRecency,
  relTime,
} from "./review-model";
import {
  AuthorAvatar,
  Centered,
  DiffStat,
  ErrorCallout,
} from "./review-shared-components";

export function ReviewCommitsSection({
  commits,
  loading,
  error,
  onRetry,
}: {
  commits: PrCommitSummary[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const groups = useMemo(() => groupCommitsByRecency(commits ?? []), [commits]);

  if (loading && !commits) return <div className="min-h-24" aria-busy="true" />;
  if (error && !commits)
    return (
      <div className="p-3">
        <ErrorCallout text={error} onRetry={onRetry} />
      </div>
    );
  if (!commits) return null;
  if (commits.length === 0)
    return <Centered>No commits on this pull request yet.</Centered>;

  return (
    <div className="flex flex-col pb-3">
      {groups.map((g) => (
        <div key={g.label}>
          <div className="border-border1 bg-bg1 sticky top-0 z-10 flex h-7 items-center gap-2 border-b px-3">
            <span className="text-fg1 text-xs font-medium">{g.label}</span>
            <span className="text-muted-fg text-xs tabular-nums">
              {g.commits.length}
            </span>
          </div>
          {g.commits.map((c) => (
            <CommitRow key={c.sha} commit={c} />
          ))}
        </div>
      ))}
    </div>
  );
}

function CommitRow({ commit: c }: { commit: PrCommitSummary }) {
  const meta = [
    c.changedFiles != null &&
      `${c.changedFiles} ${c.changedFiles === 1 ? "file" : "files"}`,
    relTime(c.date),
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className="hover:bg-bg1-hover flex flex-col gap-1 px-3 py-2 transition-colors duration-120 ease-out">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-fg1 min-w-0 truncate text-xs font-medium">
          {c.message.split("\n")[0]}
        </span>
        <DiffStat
          additions={c.additions ?? 0}
          deletions={c.deletions ?? 0}
          className="text-2xxs"
        />
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex shrink-0 -space-x-1.5">
          <AuthorAvatar
            login={c.authorLogin ?? c.authorName}
            avatarUrl={c.authorAvatarUrl}
            className="ring-bg1 size-4 ring-1"
          />
          {c.coAuthors.map((a) => (
            <AuthorAvatar
              key={a.name}
              login={a.name}
              avatarUrl={a.avatarUrl}
              className="ring-bg1 size-4 ring-1"
            />
          ))}
        </span>
        <span className="text-2xxs text-fg2 min-w-0 truncate">
          <span className="text-fg1">{commitAuthorsLabel(c)}</span>
          {meta && <span> {meta}</span>}
        </span>
        <span className="text-2xxs text-muted-fg ml-auto shrink-0 font-mono">
          {c.abbreviatedSha}
        </span>
      </div>
    </div>
  );
}
