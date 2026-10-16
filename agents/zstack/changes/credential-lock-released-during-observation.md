## Credential lock released before inspection

Concurrent refresh could leak a raw `ENOENT` after `mkdir` reported `EEXIST`:
the holder was allowed to remove the directory before the contender's `lstat`.
That disappearance means retry acquisition, within the original deadline.
It does not authorize deleting another holder's lock or skipping owner, mode,
type and inode checks for an entry that still exists.

The credential-file suite removes a real lock in the filesystem seam between
those two calls, with no sleep, and verifies immediate acquisition and the
unchanged expired-deadline refusal. The session suite retains the concurrent
single-refresh contract. The matching eval records both checks.
