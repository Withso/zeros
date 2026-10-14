## Recover a run lock only with process-identity proof

A killed CLI cannot run `finally`, and age does not show whether its holder is
dead. New zeros-dev run locks publish a private PID, Linux boot/PID-namespace
and process-start identity before work. Recovery requires the same host and
namespace to prove the process is absent or the PID belongs to a new process.
Live, foreign-host and unverifiable owners remain busy. Empty legacy locks
still need manual confirmation; missing evidence is not permission to steal.

Two reclaimers must not rename or delete a new holder's directory. Consume the
old owner filename atomically inside the opened old directory to claim recovery,
then retire that directory before removing its record. A recovery claim names
its own process so another invocation can recover a killed reclaimer too.

The regression kills a real child with SIGKILL, preserves the exact signed
intent bytes, refuses a live holder and reclaimer, simulates PID reuse, and
holds concurrent reclaimers at a callback barrier without sleeps. Aliased,
writable, malformed and replaced locks fail closed. The credential lock and
product workspace lifecycle are outside this change.

Proposed playbook guidance at the next pack fold: distinguish lock contention
from process death, and test both crash recovery and a successor acquiring the
same pathname. Keep this lesson in its own fragment to avoid the shared
`bug-fix.md` append conflicts.
