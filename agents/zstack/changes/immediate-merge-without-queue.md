# Immediate merge is a distinct operation

Symptom: an immediate-only landing authorization could not use the required
merge wrapper because its only mode armed auto-merge. Removing `--auto` from
`gh pr merge` is insufficient: the CLI can still enqueue or arm a merge-queue PR.

Cause: the high-level CLI selects an asynchronous operation for queue branches;
a successful request does not prove that the reviewed head actually merged.

Rule: explicitly select `pnpm agent:merge <n> --immediate` for immediate-only
authorization. Use fresh fail-closed preflights and the server expected-head
guard, refuse queue/armed/bypass-capable states, never cancel someone else's
request and report success only with a confirmed merged SHA. This does not
authorize an agent to merge its own tooling change or bypass owner-only CI paths.

Encoded in `scripts/agent-merge.mjs`, the isolated immediate-mode regressions,
the retained legacy-mode suite and `docs/ci.md`. Native-stack configurations
unsupported by the synchronous API refuse rather than changing their base or
falling back to queue admission. The one-armed guard remains a cross-workspace
snapshot; serialized authorization is still required.
