# Operator plan and execute version race

- Symptom: an owner-approved operator deletion failed closed with "approval
  does not match the target-bound plan" when plan and execute ran as two
  separate commands.
- Cause: the approval embeds the target's version snapshot, and a stopped
  workspace's version still ticks (two increments within 1.7 s observed).
- Rule: run plan and execute in one process, and retry the pair only on that
  mismatch.
- Encoded in `playbooks/alpha-operator.md` (Collisions and cleanup).
