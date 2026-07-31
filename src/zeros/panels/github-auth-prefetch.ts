// Intent prefetch for Settings → Integrations. Keep this free of React so
// pointer and keyboard-focus handlers can warm the exact auth snapshot before
// the panel's urgent navigation render.

import type { GithubAuthSnapshot } from "@zeros/core/github-auth";

import { ghAuthSnapshot } from "../../native/git";
import {
  ghAuthStatusCache,
  GITHUB_READ_MAX_AGE_MS,
} from "../store/read-caches";

export function prefetchGithubAuthSnapshot(
  fetcher: () => Promise<GithubAuthSnapshot> = () => ghAuthSnapshot(),
): void {
  void ghAuthStatusCache
    .load("auth", fetcher, { maxAgeMs: GITHUB_READ_MAX_AGE_MS })
    .catch(() => {
      // The cache retains any confirmed snapshot and carries the error for the
      // panel to render. Intent itself must never reject into an event handler.
    });
}
