# Verify the native journal reader

A dormant journal's held FD and repeated pathname guards accepted empty state
from a second database swapped only around SQLite's native open. The original
still held pending custody. A descriptor-count-only correction also accepted
SQLite's real cached-FD reuse when an unrelated original-file open masked it.

Bind the native reader, not only the name and an adjacent descriptor. The Linux
journal now requires a new original inode/mount FD and positive kernel evidence
of that FD owning SQLite's bounded transaction reservation. Ambiguous evidence
refuses without clearing custody. Node tests cover both real races, FD reuse,
replacement, native read failure, concurrent reservations and release. Runtime
driver/kernel qualification remains separate from these local controls.

Encoded in the retained journal-reader and journal-descriptor regression suites,
the complete-checkpoint journal, its documentation, and zstack-review's native
reader rule. No new production caller or serialized format is introduced.

A same-inode peer exposed a second cleanup hazard: closing the independent
read/write original FD released the process's POSIX reservation even though
the peer still reported an active transaction. Pin originals with `O_PATH`,
sync through the positively witnessed native reader, and publish a new journal
only after its independent creator has closed. Preserve the native witness.
The lock and lock-boundary suites retain real kernel evidence and a separate
SQLite process across failure, successful close, late read/write reservations,
creation publication and cleanup. The review rule now requires that evidence
instead of relying on the native connection's transaction flag.

CodeQL also caught a pathname reopen after the creator's metadata check. Derive
the O_PATH reference through the still-open no-follow creator and validate both
descriptors before releasing it; the creator still closes before canonical
publication. The real-FD lifetime regression and reference-open/validation
cleanup controls retain that ordering. Tests observe file bytes and metadata
through one no-follow handle too; a private fixture directory does not waive a
file-system-race finding. The native SQLite reservation witness is unchanged.
