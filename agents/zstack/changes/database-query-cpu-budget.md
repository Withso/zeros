# Database query CPU budget

- Symptom: the Alpha database ran near 76% CPU on its smallest size at a load
  of about fifteen queries per second.
- Cause: a few recurring queries each cost tens of milliseconds of CPU, and
  the database had only a 1/16 vCPU share (62.5 ms of CPU per second).
- Rule: price every recurring query as CPU per call times calls per second,
  against the database's vCPU share times 1000 ms/s.
- Encoded in `skills/zstack-review/SKILL.md` (Database cost).
