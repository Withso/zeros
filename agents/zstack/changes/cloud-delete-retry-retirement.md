# Deletion retries retain history without stranding retirement

A final checkpoint failure left a failed lifecycle DELETE and a pending deletion
job. A fresh stopped-workspace DELETE could progress resource cleanup, but its
retirement read still required the job's old key and rejected every historical
failed DELETE. A later accepted retry could never obtain the exact receipt.

Bind the job to the fresh accepted intent under the existing workspace lock.
Replay normally updates only the job already bound to that same intent. A
successor accepted before deployment can adopt its failed predecessor only
when it is the sole other DELETE in the current generation and began after
that failure. A deploy alone cannot perform this request-time reconciliation.
Ambiguous histories stay closed; timestamps alone cannot choose among requests.
An older failed replay cannot replace the successor or reset its failed cleanup.
Cover the operator's already-deleted skip as well: an accepted retry can finish
before deployment. Its exact replay may reconcile only linkage, never create
another request/job or restart a failed record purge without its explicit mode.
Keep the immutable failed intent, and validate the selected current DELETE
together with every generation, access fence, compute settlement and fresh
provider proof. Recheck the exact snapshot after external I/O.

Real PostgreSQL/service regressions retain the original checkpoint-expiry path,
the old-key replay race, current-intent failure and replacement during provider
observation. The signed harness recovery boundary remains separate: a fresh
product receipt never rewrites the original failed run or silently starts a
new qualification window.
