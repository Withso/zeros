# Preserve the final seal across competing stop paths

A lease tick treated a requested user stop as unavailable compute and created
a competing stop intent. That cancelled the user's checkpoint; the replacement
could stop the VM without sealing its current native writer. Resume then
correctly refused the older checkpoint's writer identity.

Adopt the existing exact-generation intent, preserve its bounded checkpoint
window, and escalate that same intent only through an explicit unsealed
fallback. Final checkpoint completion must also verify the native writer seal.
Audit every direct provider-stop path, including pre-deletion settlement and
callers without a lifecycle intent. Record the unsealed decision before the
provider call, while keeping positive provider retirement proof separate.

The regression holds a user checkpoint across real Postgres lease ticks and
tests expiry, idempotent audit, native seal completion and both direct
settlement paths. The bug-fix playbook and `cloud-stop-seal-budget-race` eval
retain these checks. Synthetic checkpoint-gate failures are additional source
findings, not claims that they independently initiated the observed incident.
