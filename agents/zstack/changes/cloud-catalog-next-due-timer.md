- **A hidden or stable catalog still woke every two seconds.** The fetch guard
  suppressed requests but left the interval running. Use one visible next-due
  timeout and measure callbacks as well as requests in fake-clock tests.
- **A slow disk cache stalled the first replacement scheduler.** Network
  observation and presentation restoration had shared one promise lifetime.
  Release the network flight before restoring cached chat metadata, then check
  current workspace eligibility after the await to prevent deleted rows from
  returning. Account A → B → A responses must not own the new account's timer
  (`docs/ui-interaction-performance.md`, case `cloud-catalog-next-due-timer`).
