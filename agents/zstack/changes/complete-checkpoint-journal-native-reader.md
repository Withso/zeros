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
