// Keep this React-free so pointer and focus handlers can warm the auth cache.

import type { GithubAuthSnapshot } from "@zeros/protocol/github-auth";

import { ghAuthSnapshot } from "../../platform/git";
import {
  ghAuthStatusCache,
  GITHUB_READ_MAX_AGE_MS,
} from "../../state/read-caches";

export function prefetchGithubAuthSnapshot(
  fetcher: () => Promise<GithubAuthSnapshot> = () => ghAuthSnapshot(),
): void {
  void ghAuthStatusCache
    .load("auth", fetcher, { maxAgeMs: GITHUB_READ_MAX_AGE_MS })
    .catch(() => {
      // The cache records the failure; do not reject into the intent handler.
    });
}
