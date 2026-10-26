# PR discovery uses canonical identity and recoverable observations

- A repository transfer left PR discovery empty while the CLI successfully
  created the PR. GitHub redirects repository URLs but preserves qualified
  head filters. Resolve the canonical repository before qualifying the head,
  and validate its stable repository ID as well as the branch. The GitHub mock
  must enforce the real head filter; returning every PR hid this failure.
- Newer closed PRs could hide a live PR beyond a bounded page. Discover open
  PRs first, and reconcile an already recorded PR by number. A failed detail
  read cannot establish a closed state, including when the head repository
  was deleted. Keep a recorded PR's repository URL with its number: a new Git
  remote can contain an unrelated PR with the same number. Re-read the remote
  and workspace before publication. `sync-workspace-pr.test.ts` retains these
  cases and held-response checks across branch, remote, organization and
  deletion changes.
- A slow discovery exceeded a database-oriented request budget and its late
  completion excluded the caller. Give network observations their finite
  network budget and echo successful durable reconciliation to every client.
  Bridge fake-clock tests and the workspace broadcast classifier cover both.
- A refresh arriving during a read was dropped, and errors looked like a
  successful empty result. Coalesce one successor using the currently mounted
  owner, gate it while hidden, retain exact-key discovery failures, and route
  retry through the shared Workbench status source. A return from GitHub or a
  manual retry also queues one fresh lookup, even without a Git generation
  change; multiple consumers share that retry. Evicting probe bookkeeping must
  retire its pending presentation too, or late-response rejection pins a
  loading entry forever. A refresh failure retains the last confirmed result
  alongside the error banner. PR activity and Review
  rendering tests cover Local Personal and organization owners; cloud worker
  tests preserve its separate CLI-based metadata lookup.
