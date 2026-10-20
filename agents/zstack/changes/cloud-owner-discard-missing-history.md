# Missing live history after an owner discard

An explicitly approved checkpoint restore reached a fresh allocation with an
older acknowledged history artifact and no live FULL ledger. The fallback
tried to inventory the missing live file before requesting recovery authority,
so boot failed even though the retained files were valid.

Distinguish absent custody from corrupt or conflicting custody at the real
restore boundary. A historical artifact does not prove the missing successor's
history. Require an exact owner discard, positive source retirement and current
target authority before taking an immutable CP mirror projection; retain
unknown coverage, accepted IDs and edit/delete fences without replaying work.
A failed candidate needs its own cleanup proof and a new explicit retry.

The actual engine, native SQLite and real PostgreSQL regressions cover this
boundary. Additional retained tests bind the staged SQLite reader to the full
ancestor inventory (including credential ACKs), preserve recovered mutation
fences through a later unsealed restore, and keep all nested inventory reads on
one original monotonic deadline. The bug-fix playbook and seeded
`cloud-owner-discard-missing-history` eval carry the lesson forward.

Review also exposed that an installed snapshot marker proves only the CP
projection. Replaying it must compare retained native ACKs, start fences and
retirement floors against the acknowledged ancestor, and compare prepared
custody against its original retained digest. Recomputing that digest from a
changed local file would approve the change. Six deletion regressions plus
unchanged crash-replay, changed-ACK and prepared-digest controls enforce this.
The protocol file is also an explicit control-plane CI input, covered by the
existing import-closure test.
