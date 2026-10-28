# Keep speculative Design details inside their active lifetime

- Symptom: a focused-row read could publish after its retained surface hid,
  its directory went A → B → A, its runtime advanced generation, or its queue
  was reset. Expanding prefetch also evicted selected inspector values at the
  existing detail-cache limit.
- Cause: admission checked active/runtime identity, but completion checked only
  the connection object and reply source version. Cache eviction did not
  distinguish speculative details from the selected inspector's resident data.
- Rule: a speculative read needs the same exact owner, folder, page/directory
  revision, active runtime, source generation and live queue at completion as
  at admission. Cancel obsolete windows, bound pending owners and nodes, and
  keep selected details resident without raising the cache budget.
- Encoded in `design-node-warming.test.ts`: held replies across every retirement
  boundary, empty-window cancellation, bounded idle prefetch with focus priority,
  Personal/organization Local isolation and selected-detail retention at 32
  cached nodes. `design-node-warming-lifetime.json` replays the four escaped
  completion/retirement cases independently of the new window API.
