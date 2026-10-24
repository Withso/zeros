# Cloud transcript pills on the first frame

- Symptom: new cloud chat tabs briefly showed Created/Branched rows before
  transcript pills; restarts and stopped workspaces repeated the gap.
- Cause: exclusion lived in the shared read key, cloud summaries had no durable
  or resident seed, failures became empty lists, and provenance still waited
  for independent workspace details after a nonempty seed was ready.
- Rule: share one exact account/backend/folder list and filter the current chat
  locally. Seed synchronously from a bounded owner envelope and real resident
  user prompts; untouched titles prove nothing. Publish the first-prompt overlay
  at private commit. Known cloud pills render without workspace-detail I/O.
- Keep persistence and cache publication under the same read lifetime, including
  deletion during a held first read. Recompute memory seeds on deletion, fence
  account A → B → A replies, and bound cloud pending overlays independently of
  Local behavior. Never turn a failed read into confirmed emptiness.
- Recheck shared visible-key ownership at queued dispatch, not just when the
  React effect ran: an invalidation can outlive the tab that queued it. Keep
  intent warming explicit and permit a still-visible sibling to own the read.
- Encoded in `cloud-transcript-summaries.test.ts`,
  `cloud-transcript-summary-activity.test.ts`, `cloud-summary-history-client.test.ts`
  and the real two-tab/restart/deletion browser scenario in
  `scripts/ui-smoke-transcript-row.mjs`. Inspect the first rendered provenance
  with both summary and workspace-detail reads held; hook-only tests missed the
  second waterfall.
