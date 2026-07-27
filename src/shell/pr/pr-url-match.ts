// ──────────────────────────────────────────────────────────
// PR URL matching — is this link the active workspace's PR?
// ──────────────────────────────────────────────────────────
//
// Any click on the ACTIVE PR's link (agent-chat output, the PR island's #N
// chip) should land on the Review tab instead of the external browser.
// These helpers decide "is this URL that PR" — pure, so the matching rules
// are unit-testable.

interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

/** Parse a github.com pull-request URL. Tolerates www., a trailing slash,
 *  and any suffix path/query/hash (/files, /checks, ?diff=split, #issue-…) —
 *  those all still identify the same PR. Returns null for anything else
 *  (non-GitHub hosts, issues, compare pages, plain prose). */
export function parsePrUrl(url: string): ParsedPrUrl | null {
  const m = url
    .trim()
    .match(
      /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i,
    );
  if (!m) return null;
  return {
    owner: m[1].toLowerCase(),
    repo: m[2].toLowerCase(),
    number: Number(m[3]),
  };
}

/** True when `url` points at the active workspace's PR (`prNumber` +
 *  `prUrl`). With a known prUrl the owner/repo must match too; without one
 *  (not yet synced) the PR number alone decides — the active-workspace
 *  context makes a same-number foreign-repo link vanishingly unlikely. */
export function isActivePrUrl(
  url: string,
  prUrl: string | null,
  prNumber: number,
): boolean {
  const target = parsePrUrl(url);
  if (!target || target.number !== prNumber) return false;
  const own = prUrl ? parsePrUrl(prUrl) : null;
  if (own) return target.owner === own.owner && target.repo === own.repo;
  return true;
}
