# macOS effective file access

Symptom → A Full Disk Access label can look enabled while the app's own System
Settings toggle is off, or become falsely positive when a probe file is absent.

Cause → macOS uses responsible-process attribution (including development
launchers), exposes no public TCC-toggle query, and file existence is not proof
of readable protected data.

Rule → Report effective access, require a successful read-only open of a known
protected regular file, and leave missing or ambiguous probes unknown. Never
turn the OS observation into provider approval policy. Verify native process
inheritance on macOS and record user-controlled grant/revocation gaps explicitly.

Encoded → `electron/full-disk-access.ts`, its native/IPC regressions, the
settings observation/race tests and `ui-smoke-full-disk-access.mjs`;
`docs/agent-harness-capability-boundary.md` documents the boundary.

Review also reproduced a rejected native read publishing an error after the
window became hidden but before its visibility event. The same final visibility
fence now covers successful, malformed and failed replies; the retained
regression holds and rejects the real cache fetch across that transition.
