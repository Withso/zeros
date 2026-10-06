# Staging qualified runtimes while work continues

The Alpha control plane can stage a newer qualified runtime on a running
organization workspace without retiring its engine. `CLOUD_RUNTIME_STAGING_ENABLED`
defaults to `false`. It requires the hosted Boat backend and runtime artifact
store. It never enables activation, changes runtime pointers, obtains enrollment
grants or restarts a workspace. Keep it disabled until the staged installer and
transition path are qualified together.

Qualification success, confirmed Alpha release publication and runtime revocation
send an empty PostgreSQL notification in their existing transaction. Notifications
carry no authority, identity or artifact capability. The existing dedicated
worker listener wakes staging after commit and reconnect. A 15-second poll and
startup scan recover lost hints, including qualifications written out of band.

Discovery includes `ready` and `busy` workspaces belonging to staff, with a live
engine and hosted Boat binding. It uses the existing selector for the exact base,
protocol, qualification mode and delegated credential kinds. It does not inspect
client presence, PTYs, idle time or agent turns. Local-owner and organization-owned
local workspaces do not use this control-plane worker. Owner/placement switching
does not change its exact organization/workspace/generation/engine scope.

The worker calls HU's `offer`, `claim`, `renew`, `reconcile`, `staged`, `release`
and `cancelStaging` APIs. HU owns the common lock and transition journal. No new
migration or supervisor queue is introduced. The operation UUID is derived from
the source identity and discovered target, so duplicate pushes and worker restarts
join the same offer. HU reselects and fences authoritative eligibility when offering.

Each replica runs at most two downloads (the constructor caps this at four),
reads pages of 16, and keeps at most 512 retry records. A transition gets three
attempts per worker process with backoff. HU's durable 15-minute deadline bounds
retries across crashes; exhaustion cancels that offer without changing the source.
The verified installer enforces archive/expanded-size and disk checks. This slice
does not add runtime cache garbage collection.

The worker signs a short-lived artifact capability in memory, then rechecks the
source identity, live lease, qualification and latest eligible target. It invokes
the existing pinned installer over private SSH stdin with `operation: stage`;
every activation callback is denied. The installer verifies bytes beside the
active tree and preserves source processes and selection. A final eligibility
read precedes `staged`. Claim renewal and eligibility monitoring run every 25
seconds; lease loss, shutdown or a changed source discard the result. A cancelled
download can finish verified cache bytes on the VM, but has no activation authority.
Diagnostics use closed labels and contain no provider output or signed URLs.

Superseded and revoked offers are cancelled under HU's fenced API. A valid staged
offer is released immediately for HU's activation worker. That worker must still
recheck current eligibility, latest-target supersession and its quiet/safe-point
policy at activation, then obtain fresh proofs and enrollment. A stage receipt is
neither an attestation nor permission to activate.

Local tests cover busy-source staging, real transition receipts, transactional
notifications, duplicate/lost hints, source and tenant mismatches, revocation,
supersession, worker lease loss, retries and shutdown. No live provider operation
or latency claim is made by these tests. The Alpha acceptance runner separately
verifies actual pointer/process preservation and the subsequent handoff.
