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

Independent review exposed a second boundary: a REST human identity can differ
from the effective GraphQL permission reader, and a GraphQL bot can have typename
`User`. Bind login and immutable IDs on every GraphQL read to the original REST
human, refresh REST before the final fence and confirm the actual merger in both
receipts. A mismatched connection must refuse without credential substitution.
The installed CLI maps optional neutral results to `skipping/NEUTRAL`, not
`pass/NEUTRAL`; use actual provider-shaped fixtures and refuse malformed pairs.
Production-path regressions retain both counterexamples. Unsupported-option
reds establish feature absence, not historical safety bugs; evaluate authority
guards against a revision that actually supports the option.

GitHub-generated authorship is another independent boundary. Read and pin the
effective workspace Git author email, pass the API's explicit `authorEmail`
input and verify the actual commit author in both receipts. Saved local config
and historical merges cannot prove a future server default. Treat email as
metadata, never authentication; missing or drifting identity and unconfirmed
authorship refuse without fallback. Generated committer metadata remains the
server's responsibility rather than a promise made by local Git configuration.
