# Cloud diagnostic export

- Symptom: exported app logs retained cloud bridge failures but omitted the
  VM engine and agent-run events needed to explain them.
- Cause: the desktop persisted its console stream; receiving a typed VM frame
  did not produce a diagnostic record. The compatible bridge envelope also
  permits private payload fields, so logging the whole frame is unsafe.
- Rule: project closed metadata after the current socket/boot identity fence,
  keep observer provenance, and bound emission before persistence. Exercise
  the real renderer capture, IPC handler, JSONL store and exported file;
  logger-only assertions do not establish export coverage or privacy.
- Encoded in `cloud-runtime-diagnostics.ts` and
  `cloud-diagnostic-export.test.ts`: VM inclusion, pre-persistence omission of
  private data, Local controls, A → B → A, old engines, disconnected export,
  hostile values, bounded storms and a throwing observer. Distinct request
  IDs separate the rate-budget check from existing duplicate-line coalescing.
