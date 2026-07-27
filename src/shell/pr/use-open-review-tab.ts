// ──────────────────────────────────────────────────────────
// useShowReviewTab / useOpenPrUrlInReviewTab — route to the Review tab
// ──────────────────────────────────────────────────────────
//
// The active workspace's PR review surface is THE pinned "Review" tab in row 1
// (ReviewRow1Tab → ReviewView). These hooks focus it:
//   • useShowReviewTab()        — activate the Review tab (used by the PR
//                                 island's #N chip and Show-checks button).
//   • useOpenPrUrlInReviewTab() — given a clicked URL, if it points at THIS
//                                 workspace's PR (see isActivePrUrl) focus the
//                                 tab and return true (the caller
//                                 preventDefaults); otherwise return false so
//                                 the link opens externally as before. Used by
//                                 the agent-chat markdown click delegate.
//
// useColumn3Tabs reads the ACTIVE worktree's row-1 slice — the same scope the
// island / chat operate on — so the activated Review tab is always the one for
// the workspace whose PR was clicked.

import { useCallback } from "react";

import { useColumn3Tabs, useWorkspaceDispatch } from "@/zeros/store/store";
import type { ReviewSubtab } from "../column3-tab-manager";
import { useActiveWorkspace } from "@/zeros/store/use-active-workspace";
import { isActivePrUrl } from "./pr-url-match";

/** Activate row 1's pinned Review tab (the PR review surface). The tab always
 *  exists (normalizeRow1Tabs seeds it), so this is a plain focus. */
export function useShowReviewTab(): (subtab?: ReviewSubtab) => void {
  const tabs = useColumn3Tabs();
  const dispatch = useWorkspaceDispatch();
  return useCallback(
    (subtab?: ReviewSubtab) => {
      const review = tabs.find((t) => t.type === "review");
      if (review) {
        dispatch({
          type: "OPEN_COLUMN3_TAB",
          id: review.id,
          updates: subtab ? { reviewSubtab: subtab } : undefined,
        });
      }
    },
    [tabs, dispatch],
  );
}

/** Handler for a clicked link: route the ACTIVE workspace's PR link to the
 *  Review tab (returns true → caller preventDefaults); anything else returns
 *  false and the link proceeds normally (external browser). */
export function useOpenPrUrlInReviewTab(): (url: string) => boolean {
  const { workspace } = useActiveWorkspace();
  const showReview = useShowReviewTab();
  const prNumber = workspace?.prNumber ?? null;
  const prUrl = workspace?.prUrl ?? null;
  return useCallback(
    (url: string) => {
      if (prNumber == null) return false;
      if (!isActivePrUrl(url, prUrl, prNumber)) return false;
      showReview();
      return true;
    },
    [prNumber, prUrl, showReview],
  );
}
