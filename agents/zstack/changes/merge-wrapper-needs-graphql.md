# Cloud-session merges: the wrapper needs GraphQL, and labels miss the first run

**Symptom.** In a Claude Code cloud session, `pnpm agent:merge <pr> --dry-run`
stopped with "Unable to complete the merge safety check or request". A direct
`gh api graphql` call returned HTTP 403: "GitHub GraphQL is not available from
Claude Code sessions". A PR opened through the GitHub connector and then
labelled `ci:ui-smoke` showed six red roll-ups from its first run.

**Cause.** The wrapper reads the PR, its required checks and the other open
PRs, and arms auto-merge, through `gh api graphql`. That session's proxy
allows only REST and its own CCR routes. The connector's create call takes no
labels, so the label always lands after the full run that opening started,
and the labelled run cancels it.

**Rule.** Do not arm the merge some other way on your own: the wrapper is the
only merge path. Get CI green, check by hand what the wrapper would check (the required
sections, no incident markers, no skip markers, no failed required checks, no other armed PR), then hand the merge to
the owner: one click on the PR, or `pnpm agent:merge <pr>` from a terminal
where `gh` has normal GitHub access. Merge through the connector only when the
owner asks for that PR: once every check is done and the PR reads `clean`,
run `decideMerge` over connector reads and the local diff from the merge
base, squash as `<title> (#<n>)` with the PR body and `expectedHeadSha`, and
read the merge back. The connector cannot show other PRs' auto-merge state,
so report that gap. Label a connector PR as soon as it opens and read only the
labelled run: the cancelled run's `true:cancelled` roll-ups are not failures.

**Encoded in.** Target: the merge step of
`agents/zstack/playbooks/integrate-pr.md`.
