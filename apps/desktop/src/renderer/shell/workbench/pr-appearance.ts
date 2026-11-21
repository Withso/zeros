// Review comes forward when the workspace's pull request first appears while it
// is watched: a live "no pull request" turning into one. Each repository of a
// workspace of several is watched under its own key, so switching to another
// repository that already has a pull request is not one appearing.

/** Records `prNumber` for `key`; true when it turned from a seen null into a number. */
export function observePullRequestAppearance(seen: Map<string, number | null>, key: string, prNumber: number | null): boolean {
  const previous = seen.get(key);
  seen.set(key, prNumber);
  return previous === null && prNumber != null;
}
