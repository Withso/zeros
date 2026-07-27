// ──────────────────────────────────────────────────────────
// github-url — build a GitHub "open a PR" compare URL from an origin remote
// ──────────────────────────────────────────────────────────
//
// "Create PR manually" opens GitHub's compare/new-PR page in the browser
// instead of delegating to the agent. We only have the repo's origin URL
// (project.originUrl) + the branches, so parse owner/repo/host out of the
// remote (SSH or HTTPS) and assemble the compare URL. Pure — unit tested.
// ──────────────────────────────────────────────────────────

interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

/** Parse `git@host:owner/repo(.git)` or `https://host/owner/repo(.git)` (also
 *  `ssh://git@host/owner/repo`). Returns null for anything we can't recognise. */
export function parseRemote(originUrl: string | null | undefined): ParsedRemote | null {
  if (!originUrl) return null;
  const url = originUrl.trim();

  // scp-like SSH: git@github.com:owner/repo.git
  const scp = url.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) {
    return buildParsed(scp[1], scp[2]);
  }

  // URL form: https://host/owner/repo(.git) | ssh://git@host/owner/repo
  try {
    const u = new URL(url);
    return buildParsed(u.host, u.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

function buildParsed(host: string, path: string): ParsedRemote | null {
  const clean = path.replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length < 2 || !host) return null;
  // owner/repo are the LAST two segments (handles ssh://host/gh/owner/repo too).
  const repo = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  if (!owner || !repo) return null;
  return { host, owner, repo };
}

/** Build `https://<host>/<owner>/<repo>/compare/<base>...<head>?expand=1`.
 *  Returns null when the remote can't be parsed. Branch names are URL-encoded
 *  segment-wise (slashes in `zeros/foo` are preserved as path separators, which
 *  is what GitHub's compare route expects). */
export function githubCompareUrl(
  originUrl: string | null | undefined,
  baseBranch: string,
  headBranch: string,
): string | null {
  const remote = parseRemote(originUrl);
  if (!remote) return null;
  const enc = (b: string) =>
    b
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
  return `https://${remote.host}/${remote.owner}/${remote.repo}/compare/${enc(
    baseBranch,
  )}...${enc(headBranch)}?expand=1`;
}
