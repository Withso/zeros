# Canonical controls retain their original writer cursor

An inherited conversation manifest could be rejected after a writer handoff even
when its original compact controls were already authenticated and stored. The
history validator compared their old outbox positions to the successor's reset
publication ordinal.

Validate current-writer controls against the current transaction and retired
controls against their own committed mirror cursor. Preserve exact native
stream, event, command and frame identity. Reprojecting history must not rewrite
the original row or create a live permission event.

The real Postgres history-mirror regression retains a high predecessor ordinal,
an exact low successor ordinal, and refusals for missing committed coverage or
changed native identity. The bug-fix playbook and matching replay case retain the
same boundary.
