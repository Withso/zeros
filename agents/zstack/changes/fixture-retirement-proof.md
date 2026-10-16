# Separate fixture compute retirement from storage erasure

Hourly fixture cleanup inherited a physical-deletion requirement while Boat
could retain already unavailable compute behind a six-hour upload fence. Shorter
CP polling would neither remove that fence nor safely prove deletion.

The optional authenticated retirement observation now requires an exact accepted
delete, every generation, settled compute and access, a fresh storage-only
deletion receipt plus sandbox absence, and an authority recheck after I/O. It
retains disk reservations and leaves deletionConfirmed false. Real D1 worker
coverage proves the original identity and physical-completion evidence survive
content purge. Pool barriers prove no client stays held across provider reads.

The bug-fix playbook and fixture-retirement-proof scenario encode these checks.
The harness owns signed carry and bounded deferred admission separately; a
pending observation never becomes an erasure receipt or native custody proof.

The disk audit also exposed a runner hazard: full process arguments can include
agent session credentials. The operator playbook now limits process inspection
to names and working directories, with PATH extracted in memory only when needed.
