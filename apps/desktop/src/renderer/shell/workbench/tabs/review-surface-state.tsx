// Which body the pinned Review tab shows, decided once and in this order, and
// the state for a repository whose remote isn't a host Zeros reviews yet.

import { ArrowUpRight, Globe } from "lucide-react";

import { EmptyState } from "@/renderer/shared/ui/layout/empty-state";
import { Button } from "@/renderer/shared/ui/primitives";

export type ReviewSurfaceState = "discovering" | "other-host" | "no-pr" | "review";

export function reviewSurfaceState(args: {
  /** Local pull request discovery hasn't answered yet. */
  discovering: boolean;
  /** The origin's host when the project records one; null when unknown. */
  remoteHost: string | null;
  hasProvider: boolean;
  /** A workspace branch with a pull request number (never Local main). */
  hasPullRequest: boolean;
}): ReviewSurfaceState {
  if (args.discovering) return "discovering";
  // A known host without a provider can never have a reviewable pull request,
  // so say why before "No pull request" sends anyone looking for one.
  if (args.remoteHost && !args.hasProvider) return "other-host";
  if (!args.hasPullRequest) return "no-pr";
  return args.hasProvider ? "review" : "no-pr";
}

/** A remote on another host (GitLab, Bitbucket, a self-hosted server). Its own
 *  web page stays one click away. */
export function ReviewHostUnavailable({
  host,
  url,
}: {
  host: string;
  url: string | null;
}) {
  return (
    <EmptyState
      icon={Globe}
      data-review-host-unavailable=""
      title="Reviews aren’t available for this host yet"
      action={
        url ? (
          <Button variant="secondary" asChild>
            <a href={url} target="_blank" rel="noreferrer">
              Open {host}
              <ArrowUpRight aria-hidden />
            </a>
          </Button>
        ) : undefined
      }
    >
      This remote is {host}; Zeros reviews GitHub today.
    </EmptyState>
  );
}
