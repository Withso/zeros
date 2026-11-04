export interface GitRemote { name: string; url: string; isGitHub: boolean }
export interface GitCatalogBranch { name: string; lastCommitDate: number }
export interface GitBranchRef extends GitCatalogBranch { tipSha: string }
export interface GitWorktreeEntry { path: string; head: string; branch: string | null; isBare: boolean; isDetached: boolean; isLocked: boolean }

/** URLs may contain spaces; only the first tab and final kind marker delimit them. */
export function parseGitRemotes(output: string, isGitHub: (url: string) => boolean): GitRemote[] {
  const byName = new Map<string, string>();
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t"), kindStart = line.lastIndexOf(" (");
    if (tab <= 0 || kindStart <= tab || !line.endsWith(")")) continue;
    const name = line.slice(0, tab), url = line.slice(tab + 1, kindStart), kind = line.slice(kindStart + 2, -1);
    if (url && (kind === "fetch" || !byName.has(name))) byName.set(name, url);
  }
  return [...byName].map(([name, url]) => ({ name, url, isGitHub: isGitHub(url) }));
}

/** Full ref prefixes avoid Git's ambiguous shortening when a tag shares a name. */
export function parseGitCatalogRefs(output: string, prefix: string): GitCatalogBranch[] {
  const result: GitCatalogBranch[] = [];
  for (const line of output.split("\n")) {
    const separator = line.lastIndexOf("|");
    if (separator < 0) continue;
    const ref = line.slice(0, separator), name = ref.slice(prefix.length);
    if (ref.startsWith(prefix) && name && name !== "HEAD") result.push({ name, lastCommitDate: (parseInt(line.slice(separator + 1), 10) || 0) * 1000 });
  }
  return result.sort((a, b) => b.lastCommitDate - a.lastCommitDate);
}

export function parseGitBranchRefs(output: string): GitBranchRef[] {
  const result: GitBranchRef[] = [], prefix = "refs/heads/";
  for (const line of output.split("\n")) {
    const [ref, tipSha, date] = line.split("|");
    if (ref.startsWith(prefix)) result.push({ name: ref.slice(prefix.length), tipSha, lastCommitDate: (parseInt(date, 10) || 0) * 1000 });
  }
  return result.sort((a, b) => b.lastCommitDate - a.lastCommitDate);
}

export function parseGitWorktrees(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | undefined;
  for (const line of [...output.split("\n"), ""]) {
    if (!line) { if (current?.path) entries.push(current); current = undefined; }
    else if (line.startsWith("worktree ")) current = { path: line.slice(9), head: "", branch: null, isBare: false, isDetached: false, isLocked: false };
    else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice("branch refs/heads/".length);
    else if (current && line === "bare") current.isBare = true;
    else if (current && line === "detached") current.isDetached = true;
    else if (current && line === "locked") current.isLocked = true;
  }
  return entries;
}
