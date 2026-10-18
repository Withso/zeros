# Compute stop deadlines and seal evidence

- Symptom: a failing draining lease could sleep through its finite stop window;
  the associated seal refusal retained only a generic unknown reason.
- Cause: active-allocation retry bounds did not cover draining backoff, and one
  seal stage combined remote refusal, response validation and local custody work.
- Rule: schedule the next upcoming safety boundary and attempt due escalation
  before provider I/O. Preserve normal metering backoff after positive stop
  proof, and ordinary failure backoff after the finite window is past. Record
  only closed refusal boundaries through a compatible, bounded evidence channel.
- Encoded in the compute lease, private seal client, frozen writer lifecycle,
  progress reporter and CP receipt regression suites; the bug-fix playbook and
  the `compute-drain-deadline-backoff` / `checkpoint-seal-refusal-evidence` evals.
- Fixture lesson: use one statement timestamp for coupled provider/funding
  deadlines and copy the complete registered generation pin in ownership races.
  Independently sampled clocks and partial runtime pins are invalid fixtures.
