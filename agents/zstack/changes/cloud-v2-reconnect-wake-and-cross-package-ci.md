Reconnect is not user activity. Cloud v2 tickets used to wake a stopped VM on
every `/connect`, so a laptop wake, network drop or control-plane deploy
restarted VMs that had idled to a stop. Persist the explicit wake intent across
both HTTP issuance and socket admission. Default to waking for callers that omit
it, so older desktops and probes keep working. The route, store, relay and
renderer passive-ticket suites retain the regression.

A suite that imports another package's sources needs that package installed in
its CI job. The worker's hybrid-transport tests drive the real control-plane
relay and signer. They passed locally, where the control plane's
`node_modules` exist, and failed CI typecheck until the worker job installed
the control plane. When a test crosses a package boundary, check the CI job's
install steps and the database-scope inputs together.

Long local gate batches die with the agent session unless detached. Run them
with `setsid nohup` under the shared lock, append each result to a summary
file, and watch that file. One lock hold per heavy batch lets another agent's
short red run interleave.

A first-focus Escape smoke must release every overlay it opened. Escape
returns focus to the trigger, whose tooltip publishes its own native overlay
intent. Blur the trigger and move the pointer away before asserting that the
menu released the shared intent.
