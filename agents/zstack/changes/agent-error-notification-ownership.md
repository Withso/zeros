# Error state is not a new notification

Reopening or revealing a failed chat repeated a generic agent toast. A label-only
ref also hid distinct new failures. Account-retired conversation reads were
untyped protocol errors, and cloud authentication failures refreshed Local
connection state.

Rule for bug-fix: test mount, conceal/reveal, repeated serialized snapshots and
owner A to B to A separately from new failure transitions. Seed notification
observation with current state, preserve failures in the transcript/auth notice,
and keep typed ownership cancellation quiet without automatic replay. Refresh
authentication metadata only for the failing placement. Never duplicate free
provider error text in render-effect console output.

Encoded in the actual AgentChat effect tests, held WorkspaceRuntimeClient
account-change regressions, and existing send-failure/auth presentation suites.
Eval: `agent-error-notification-ownership`.

Extracted callback tests must assert that the real boundary was found. Renaming
a private observation ref left an adjacent readiness test executing an empty
script. Exercise the actual ref initialization and a warming-to-failed transition
for Local Personal, organization-local and cloud queued waits; a retained failed
snapshot on mount is a different contract. Include that adjacent suite in the eval.
Replace a statement-order regex for auth refresh with real effect assertions:
non-auth failures never probe any provider, while auth failures refresh only
their owning placement. A new cloud branch must not require a Local-only layout.
