# State-aware background polling

- Symptom: the control plane kept a steady background query load while every
  provider machine was archived.
- Cause: several loops scheduled work by a resource's existence rather than
  its state.
- Rule: archived and stopped resources are not polled at running cadence;
  derive the next due time from the state.
- Encoded in `skills/zstack-review/SKILL.md` (Database cost).
