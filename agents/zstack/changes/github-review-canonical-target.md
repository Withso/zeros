# Review must consume the canonical repository identity

- PR discovery succeeded after a repository transfer, but Review still failed.
  Discovery resolved the canonical GitHub owner/name while the hosted-review
  adapter validated the returned PR URL against the old Git remote spelling.
  Transfers, renames and casing differences therefore became
  `FORGE_CONTRACT_INVALID` despite a successful GitHub response.
- Resolve the canonical repository at the shared hosted-operation boundary,
  before strict identity validation. Discovery and hosted operations use the
  same resolver; concurrent reads share work without retaining an identity
  across refreshes. Read paths leave Git remotes unchanged and keep rejecting
  unrelated repository URLs.
- A regression must follow the result through its real consumer. Extend
  discovery tests through `WorkspaceService.handle("gh.prGet")`, the path the
  Review tab uses. A successful `syncWorkspacePr` assertion alone cannot prove
  that Review opens. Cover Local Personal and organization-local owners,
  transfers, renames and casing; retain cloud's separate CLI regression.
- Encoded in `sync-workspace-pr.test.ts`, `github-read-coalescing.test.ts`,
  `forge.test.ts` and the `github-review-canonical-target` eval case.

- A verified transfer also left the saved Origin and checkout remote stale.
  Bind each remote URL to GitHub's immutable repository ID and perform repairs
  in an explicit mutation, fenced by selected-auth generation, registration,
  settings and the exact Git config snapshot. Preserve custom transports and
  fork push URLs, including insteadOf/pushInsteadOf rules. A manual URL change
  retires the old binding. Encoded in `github-repository-reconciliation.test.ts`.
- A stale boot cache could undo canonical native metadata, and a revision-only
  acknowledgement could hide a concurrent successful repair. Native Origin
  revisions fence write-back; only a changed URL invalidates an in-flight
  observation. Native change notifications revalidate without another write.
  Encoded in `project-repository-reconciliation.test.ts`,
  `projects-engine-recovery.test.ts` and `change-events.test.ts`.
- Native acknowledgements make old metadata authoritative again unless writes
  distinguish an omitted Origin from an explicit removal and accept the new
  Origin of a re-added checkout. Recheck effective Git URLs after network I/O
  too: an included transport file can change without touching `.git/config`.
  Both cases have retained regressions in `github-repository-reconciliation.test.ts`.
- Placement coverage does not require adding a missing cloud feature to a
  Local fix. Test the explicit cloud exclusion and retain the existing cloud
  regression. Keep broader cloud implementation separate when the user asks
  to finish Local first.
