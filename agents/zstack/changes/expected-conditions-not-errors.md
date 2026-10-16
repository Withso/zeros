# Expected background conditions log once, at their true level

Symptom: a two-day dogfooding log carried ~110 updater lines for network
changes (three per failure, one a stack at error level), 25 "[auth-security]
stream ended: TypeError" warnings, ResizeObserver notices at error level, and
lifecycle recovery errors that repeated every launch without saying how to
unblock them. Real failures were hard to find.
Rule: a self-recovering condition (network change, deferred browser notice,
reconnecting stream) is recorded once at log or warn level without a stack;
a retained failure that repeats each launch names its remediation.
Encoded by: updater-disk-full.test.ts (transient network classification and
single warning), auth-security-monitor.test.ts (stream-end classification),
renderer-log.test.ts (benign window errors), worktree.test.ts (recovery
remediation in the log line).
Proposed target: zstack-verify, log hygiene for shared diagnostics.
