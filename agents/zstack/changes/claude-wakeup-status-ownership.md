# Claude wake-up status ownership

- Symptom: adding a lifecycle status row can acknowledge a queued cloud prompt,
  count as a message, trigger a title, extend a settled footer or imply recovery
  before the model produces any work.
- Cause: those consumers treat any agent event/text as provider progress. A
  hook notice can arrive before native activity, and tool-result due times can
  disagree with a cron-text estimate by the scheduler's per-job offset.
- Rule: carry typed status through the shared reducer and stored text payload,
  then audit every progress/output/title consumer. A wake-up identifies an
  automatic continuation, not acceptance of a user send. Join only exact
  prompts with a unique tracked candidate; use native due times and prompt
  identities, and leave ambiguity generic. Retain due-time provenance: a repeated
  Stop snapshot must not overwrite an exact ScheduleWakeup time with an estimate.
  Mirror the provider's own cardinality: the CLI keeps one pending dynamic
  wake, so a new ScheduleWakeup replaces tracked ones; otherwise a reschedule
  with the same prompt leaves two candidates and every later wake turns
  generic. An unknown due time drops only the time, never a known task name.
  Keep cloud hook status separate
  from background membership and idle policy.
- Encoded in the shared Claude wake-up contract, Local/worker hook suites,
  cloud outbox and restart persistence regressions, renderer count/partition/
  title/copy/footer tests, and the Dark/Light transcript smoke. These assertions
  cover both placements without live credentials.
