// ──────────────────────────────────────────────────────────
// ReviewCommitsSection — the Review tab's Commits sub-tab
// ──────────────────────────────────────────────────────────
//
// The PR's commits (GitHub's list — authoritative even when the local branch
// is behind) under recency buckets (Today / Yesterday / Last 7 days / Last 30
// days / month), newest first. Rows are summaries only — author(s), age, file
// count, ±stats and the short SHA, with Copy and Open on hover. The diff
// itself lives in the Changes tab, so nothing here reads the object store.

import React, { useMemo } from "react";
import { ArrowUpRight, Copy } from "lucide-react";

import type { PrCommitSummary } from "../../../platform/git";
import { IconButton, Tooltip } from "@/renderer/shared/ui/primitives";
import {
  commitAuthorsLabel,
  groupCommitsByRecency,
  relTime,
} from "./review-model";
import {
  AuthorAvatar,
  DiffStat,
  ErrorCallout,
} from "./review-shared-components";
import { copyWithToast } from "./review-overview";

export function ReviewCommitsSection({
  commits,
  loading,
  error,
  prUrl,
  onRetry,
}: {
  commits: PrCommitSummary[] | null;
  loading: boolean;
  error: string | null;
  /** The pull request's page; a commit opens beneath it. */
  prUrl: string | null;
  onRetry: () => void;
}) {
  const groups = useMemo(() => groupCommitsByRecency(commits ?? []), [commits]);

  if (loading && !commits) return <div className="min-h-24" aria-busy="true" />;
  if (error && !commits) return <ErrorCallout text={error} onRetry={onRetry} />;
  if (!commits) return null;
  if (commits.length === 0)
    return (
      <p className="text-fg3 m-0 text-xs">No commits on this pull request yet.</p>
    );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {groups.map((g) => (
        <section key={g.label} aria-label={g.label} className="flex min-w-0 flex-col">
          <div className="flex h-8 items-center gap-1.5 text-xs">
            <span className="text-fg2">{g.label}</span>
            <span className="text-fg3 tabular-nums">{g.commits.length}</span>
          </div>
          <div className="-mx-2.5 flex min-w-0 flex-col">
            {g.commits.map((c) => (
              <CommitRow key={c.sha} commit={c} prUrl={prUrl} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function CommitRow({
  commit: c,
  prUrl,
}: {
  commit: PrCommitSummary;
  prUrl: string | null;
}) {
  const files =
    c.changedFiles != null
      ? `${c.changedFiles} ${c.changedFiles === 1 ? "file" : "files"}`
      : null;
  const changed = (c.additions ?? 0) > 0 || (c.deletions ?? 0) > 0;
  return (
    <div
      data-review-commit={c.abbreviatedSha}
      className="group hover:bg-bg1-hover flex min-h-13 min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors duration-120 ease-out"
    >
      <span className="flex shrink-0 -space-x-1.5">
        <AuthorAvatar
          login={c.authorLogin ?? c.authorName}
          avatarUrl={c.authorAvatarUrl}
          className="ring-bg1 size-5 ring-1"
        />
        {c.coAuthors.map((a) => (
          <AuthorAvatar
            key={a.name}
            login={a.name}
            avatarUrl={a.avatarUrl}
            className="ring-bg1 size-5 ring-1"
          />
        ))}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-fg1 truncate text-xs">{c.message.split("\n")[0]}</span>
        <span className="text-fg3 text-3xxs flex min-w-0 items-center gap-1 leading-4">
          <span className="text-fg2 min-w-0 truncate">{commitAuthorsLabel(c)}</span>
          <span className="shrink-0">· {relTime(c.date)}</span>
          {files && <span className="shrink-0">· {files}</span>}
          {changed && (
            <>
              <span className="shrink-0">·</span>
              <DiffStat additions={c.additions ?? 0} deletions={c.deletions ?? 0} />
            </>
          )}
        </span>
      </div>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-120 ease-out group-focus-within:opacity-100 group-hover:opacity-100">
        <Tooltip label="Copy SHA">
          <IconButton
            size="compact"
            label={`Copy ${c.abbreviatedSha}`}
            className="text-fg3"
            onClick={() => copyWithToast(c.sha, "commit SHA")}
          >
            <Copy aria-hidden />
          </IconButton>
        </Tooltip>
        {prUrl && (
          <Tooltip label="Open on the pull request">
            <IconButton asChild size="compact" label={`Open ${c.abbreviatedSha}`} className="text-fg3">
              <a href={`${prUrl}/commits/${c.sha}`} target="_blank" rel="noreferrer">
                <ArrowUpRight aria-hidden />
              </a>
            </IconButton>
          </Tooltip>
        )}
      </span>
      <span className="bg-bg2 text-fg2 text-3xxs shrink-0 rounded-sm px-1.5 font-mono leading-5">
        {c.abbreviatedSha}
      </span>
    </div>
  );
}
