# Provider background work

Execution follows the [normal VM agent execution model](security.md#agent-execution-model).
The workspace VM provides isolation; ordinary conversation directories do not.

Foreground command receipts do not own native execution lifetime. On a
background-capable control plane, successful foreground completion inspects
the provider's active tasks and the native execution's descendant listeners.
Claude process work includes background tasks, bash, wakeups and workflows;
Codex refreshes native background terminals and active child turns. A listener
without a native task record appears in the existing task UI as **Workspace
server processes**. Its stop control retires that execution's original process
group; escaped or detached descendants are not proven retired by that control.
Native task controls continue to stop individual tasks, preserving siblings.

The control plane persists a bounded, revisioned active-task snapshot against
the execution lease. Each read and mutation validates the original actor,
device, authentication session, credential/delegation, qualification, engine
and workspace generation. Desktop disconnect does not release that lease.
Reload uses the same live execution and durable snapshot; historical records
cannot revive stopped processes. Completed output stays in the event journal.

The existing short lease renews at most every 20 seconds, expires within 45
seconds without renewal, and has a non-extendable four-hour cap starting at
first background retention. A queued turn cannot reset this cap. Snapshots
hold at most 64 tasks and 192 KiB of projected metadata; inspection and pending
operations also have explicit bounds. Revocation, credential expiry, actor
removal, generation changes and workspace stop/archive use the existing
original execution's process-group retirement path. Cloud launches enter one
shared workload cgroup through the original broker before exec; engine/control
processes remain outside it. Idle requires a fresh complete census of the whole
engine-runtime tree, including the engine leaf and new siblings, exempting only
exact infrastructure births and the C3 quiet populated-shell exception. Unknown means busy and
triggers bounded recovery. A per-conversation Stop proves only the original
process group, without an escaped/detached descendant guarantee. VM drain closes
launches; checkpoint and seal complete before kill. The outside root broker then
uses whole-tree `cgroup.kill` and records verified `populated=0`, because the kill
also terminates the engine. Local Host process-group behavior is unchanged.

The next queued turn reserves and reuses the same execution and history lock.
The control plane must confirm the same conversation, actor, device,
credential/delegation, model and native capability. Another actor or credential
cannot inherit the process. Stop retained work before changing those bindings
or a Claude setting that requires restarting the query. This rejection leaves
the existing authorized background work alive.

Idle stop consumes existing activity signals: a retained execution is an
unexpired control-plane agent lease, and its native processes remain visible
to the engine's fresh complete census of the entire engine-runtime tree. Neither
foreground completion nor desktop disconnect alone makes a workspace idle.
Individual retirement proves the original process group; final VM drain supplies
the separate shared-cgroup empty proof.

The private `backgroundTasksVersion: 1` admission handshake gates retention.
Legacy engines retain command-scoped retirement. New engines retry without
the optional flag only after a definite old-backend schema rejection; an
ambiguous failure is never retried as a fresh admission. Migration 0120 is
additive and stores no credential material.
