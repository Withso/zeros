Cloud follow-up commands could remain queued after failed or expired context
warming. The cache retained an interest with neither a running request nor a
retry, while dispatch only asked whether the context was ready.

An eligible queued command must own its warming progress and a bounded terminal
outcome. Reuse a live discovery request, retry only closed transient failures,
and retain the original deadline through reads and pump wakes. Keep context I/O
outside the FULL claim transaction. A late response cannot revive a failed or
removed command; a paused command receives its budget when it becomes eligible.

Encoded in the real boot/queue/pump regressions in
`cloud-local-command-queue-boot.test.ts` and the
`cloud-command-context-warming` replay case. Running execution authority has a
separate lifetime and is not changed by this admission fix.
