# Startup maintenance must not own readiness

Slow reopen → optional archive-ref scans and legacy filesystem cleanup ran
before the Local transport was ready → keep recovery and history migrations in
boot, then run optional janitors in a serial queue owned and retired by the
engine. Recheck durable workspace/lifecycle state after each awaited scan;
compare-and-delete only owned refs, preserve other instances' refs, and exclude
cloud rows from Local filesystem work. Encoded in engine-startup,
startup-maintenance and archive-snapshot-pins regressions.
Abort maintenance immediately on Stop, but dispose active tool/terminal owners
before joining a janitor queued behind their mutation lane; otherwise teardown
can wait for an owner it has not cancelled yet. Covered by a held real mutation
lane in engine-startup.
Queued maintenance must also cancel admission independently of its predecessor:
a user Git operation can hold the lane without belonging to an agent being
disposed. Cancellation preserves the predecessor's gate for later mutations,
and admitted cleanup still joins. Covered by engine-startup and mutation-lock.
Recheck cancellation at the final admission claim, including the microtask
between the awaited wait helper and the callback. Mutation-lock covers that
handoff separately from cancellation while the predecessor is held.
Hidden-ref maintenance must use `update-ref --no-deref`: a symbolic recovery
ref must never redirect cleanup or repinning into a user branch. Both direct
and dangling symbolic refs are covered by archive-snapshot-pins.
Git 2.52 and newer deliberately refuse create-only updates of dangling symrefs;
older Git replaces the internal ref under `--no-deref`. Assert the exact safe
outcomes and retained durable snapshot on both versions, rather than requiring
repinning to succeed. Never remove the old-OID comparison to pass that check:
a pin published after the repository listing must win, covered by a held-listing
regression. The original CI failure was reproduced on Git 2.55 before correcting
the version-dependent assertion.

Slow PR discussions → independent check-annotation reads were serialized and
one failed read discarded later findings → overlap a bounded first-page window,
consume in stable order under the existing payload limits, and keep each check's
failure separate. Encoded in github-inline-review regressions.

Use a one-shot barrier when holding a repository scan in a lifecycle test:
holding every ref scan also blocks the deletion being tested and proves only a
fixture deadlock. The corrected test must fail by assertion on the original code.
Browser harness transforms must track the real component export: the Changes
smoke inserted a second `export` after that component became public. Removing
the obsolete transform restores the actual browser check.
