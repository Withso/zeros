# The merge wrapper needs GraphQL, which Claude Code cloud sessions refuse

**Symptom.** In a Claude Code cloud session, `pnpm agent:merge <pr> --dry-run`
stopped with "Unable to complete the merge safety check or request". A direct
`gh api graphql` call returned HTTP 403: "GitHub GraphQL is not available from
Claude Code sessions".

**Cause.** The wrapper reads the PR, its required checks and the other open
PRs, and arms auto-merge, through `gh api graphql`. That session's proxy
allows only REST and its own CCR routes.

**Rule.** Do not arm the merge some other way: the wrapper is the only merge
path. Get CI green, check by hand what the wrapper would check (the required
sections, no CI-definition paths through `isCiDefinitionPath`, no skip
markers, no failed required checks, no other armed PR), then hand the merge to
the owner: one click on the PR, or `pnpm agent:merge <pr>` from a terminal
where `gh` has normal GitHub access.

**Encoded in.** Target: the merge step of
`agents/zstack/playbooks/integrate-pr.md`.
