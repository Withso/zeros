# Recover a terminal turn after a failed reattach read

Symptom: a completed cloud turn remained stale after ingress replacement when
the first automatic state snapshot failed and no later live event arrived.
Cause: attachment refresh settled the failure without another observation.
Rule: a transient reattach read gets one bounded observation retry; never
re-enqueue a command to repair history. Fence that retry by the exact attachment,
snapshot revision, execution, connection state and disposal lifetime.

Encoded in cloud-agent-connection.test.ts (retained red, retry bound, late-read,
detach/recreate and disconnect controls), workspace-runtime-client.test.ts
(A → B → A with a retained old callback and delayed response), and
cloud-coordinator-frontend.test.ts (real ingress SIGKILL, durable event replay,
truncated-prefix resnapshot and duplicate delivery/ACK without redispatch).
The portable process fixture proves those seams, not S1 admission, real provider
work, a systemd base or macOS behavior. The real wire fixture also rejects reads
on a disconnected socket; silently accepting them invents replay delays absent
from the production client.
