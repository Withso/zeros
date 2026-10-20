# Durable cloud Stop

Symptom: cloud Stop disappeared after a queue pause acknowledgement while the
accepted turn still ran, and reconnects could lose the pending operation.

Cause: the renderer cleared its activity before the request, the adapter owned
retries inside one transport, and a conversation-only Stop could not safely
identify its original command after a successor started. Cancellation failure
after the durable write also made a replay skip the native cancellation.

Rule: retain one command and operation across replacement peers, wait for exact
terminal custody, and bound the whole observation including connection setup.
Target the in-flight admission fence as well as the durable queue mutation.
Preserve pending Stop through metadata reattachment and provider terminal events;
clear it on an authoritative successor without touching that successor.
Revalidate a cached terminal Stop after transport replacement, and target storage
failure fallbacks as strictly as successful writes. Passive snapshots must retain
an unconfirmed Stop's error; a queued follow-up must not consume its Retry action.
Retain a turn's real failure or completion when Stop loses the race.
Native exit and boundary revocation can precede the paired command receipt.
Retain a pending Stop's logical cloud conversation route and error through those
events; only exact retirement or a successor releases its owner.

Encoded in the bridge and renderer Stop regressions, real SQLite queue and native
pump retirement/enrollment controls, negotiated protocol tests, the client runtime
contract and the bug-fix playbook. Local Personal, organization-local, owner
switching, old strict workers, lost acknowledgements and no implicit wake remain
explicit controls.
