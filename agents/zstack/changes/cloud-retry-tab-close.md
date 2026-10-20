# Cloud Retry and explicit tab close

Symptom: a lost prompt acknowledgement could leave Retry preparing another
command, and explicit close could archive a cloud tab before Stop completed.

Cause: prompt observation belonged to a replaceable connection, Retry treated
transport failure as dispatch failure, and close callers ignored the asynchronous
Stop and detach outcomes. Synthetic ACKs hid a missing conversation identity;
captured pane neighbors could disappear without advancing navigation.

Rule: retain exact command ownership above transports, recover it with bounded
passive reads, and never turn uncertainty into permission to resend. A separate
explicit retry requires fresh failed/cancelled terminal custody; success only
reconciles the original transcript. Explicit close joins the same durable Stop,
then validates the adapter's conversation ACK before archiving. Recheck live
neighbors and navigation after the wait; app disposal and navigation stay passive.

Encoded in real bridge recovery tests, renderer callback tests, the unchanged
independent cold-ACK and real-reducer regressions, and the bug-fix playbook.
Controls cover Local Personal, organization-local, account changes, A to B to A,
legacy grants, changed writers, queued payload retention and silent-read bounds.

The existing Stop proof seed was refreshed for the typed terminal-state guard;
its dispatching-as-terminal mutation still has to be caught at the frozen SHA.
