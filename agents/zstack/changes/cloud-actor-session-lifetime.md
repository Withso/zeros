# Cloud actor lifetime follows sockets and unfinished work

Historical cloud actor sessions kept renewing after their sockets disconnected,
and the boot exhausted its 256 actor slots. Disconnect had no path to release
the actor; explicit revocation intentionally kept registry replay fences.

Keep normal lifetime release separate from security revocation. Count every
socket and pending admission, even when admissions share a confirmation flight,
and derive detached work from durable queued/dispatching commands and
unproved native scopes. Release only after the final reference ends, fence late
responses by the original lifetime, and keep explicit revoke tombstones final.
Deduplicate warming by the opaque principal as well as the semantic key so a
readmitted session cannot inherit its retired predecessor's pending request.

Encoded in the boot runtime's engine-callback regression tests, registry and
factory tests, the `cloud-actor-session-lifetime` eval, and the bug-fix playbook.
Tests cover capacity across 257 historical sessions, final-release timers,
multiple sockets and admission handoffs, queue edits/settlement, native retirement
and reconnect races.
