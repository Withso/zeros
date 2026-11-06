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
export function parseRemote(
  originUrl: string | null | undefined,
): ParsedRemote | null {
  if (!originUrl) return null;
  const url = originUrl.trim();

  // scp-like SSH: git@github.com:owner/repo.git or github.com:owner/repo.git.
  // Git accepts the userless form; requiring "user@" made valid remotes lose
  // their forge identity throughout the renderer.
  const scp = url.includes("://")
    ? null
    : url.match(/^(?:[^@/:\s]+@)?([^:/\s]+):(.+)$/);
  if (scp) {
    return buildParsed(scp[1], scp[2]);
  }

  // URL form: https://host/owner/repo(.git) | ssh://git@host/owner/repo
  try {
    const u = new URL(url);
    return buildParsed(u.hostname, u.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
}

/** The engine's PR API currently targets github.com (not arbitrary Git hosts or
 * GitHub Enterprise). Use the same host gate before rendering its action. */
export function isGithubDotComRemote(
  originUrl: string | null | undefined,
): boolean {
  const parsed = parseRemote(originUrl);
  if (!parsed) return false;
  const host = parsed.host.toLowerCase().replace(/\.$/, "");
  return (
    host === "github.com" ||
    host === "www.github.com" ||
    host === "ssh.github.com"
  );
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
  if (!remote || !isGithubDotComRemote(originUrl)) return null;
  const enc = (b: string) =>
    b
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
  return `https://github.com/${remote.owner}/${remote.repo}/compare/${enc(
    baseBranch,
  )}...${enc(headBranch)}?expand=1`;
}

/** The repository's page on its own host, for a remote Zeros can't review
 *  yet. Keeps group paths (GitLab subgroups) and drops a port, because the
 *  web page is plain https. Null for anything that isn't a network remote. */
export function remoteWebUrl(
  originUrl: string | null | undefined,
): { host: string; url: string } | null {
  const raw = originUrl?.trim();
  if (!raw) return null;
  let host: string;
  let path: string;
  const scp = raw.includes("://") ? null : raw.match(/^(?:[^@/:\s]+@)?([^:/\s]+):(.+)$/);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const url = new URL(raw);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
      host = url.hostname;
      path = url.pathname;
    } catch {
      return null;
    }
  }
  const segments = path
    .replace(/\.git$/i, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  if (!host || segments.length < 2) return null;
  return {
    host,
    url: `https://${host}/${segments.map((part) => encodeURIComponent(decodeURIComponentSafe(part))).join("/")}`,
  };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
