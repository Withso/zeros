# Turn changes disclosure and long-window summaries

- Symptom: every completed turn left a file card in the thread. Cause: card
  visibility depended only on recorded files. Rule: automatic disclosure
  belongs to the actual thread tail, while historical disclosure is ephemeral
  and bound to chat, workspace, turn and tail identity. An empty successor
  still closes the older cards. Encoded in `turn-footer.test.ts`, the real
  footer browser smoke for all providers/placements, and the output-footer
  contract in `docs/agent-tool-presentation.md`.
- Symptom: a cloud turn's final summary created an empty turn after its answer
  when the opening prompt was outside the resident window. Cause: the ordinary
  whole-row reducer could see only the window and appended the updated opening.
  Rule: apply updates to the retained leading prompt beside the window, keeping
  native identity, row references, paging cursors and turn ownership intact.
  Encoded in the Local/organization/cloud regressions in
  `transcript-leading-prompt.test.ts` and the cloud completion/history tests in
  `cloud-turn-feedback.test.ts`.
- Symptom: a completed cloud diff stayed absent after its live update was lost,
  even when the mirror held the final summary. Cause: mutable opening summaries
  had no advancing freshness stamp, so the renderer refused their newer content.
  Rule: stamp changed worker summaries monotonically, retain the stamp through
  replay/import/restart, and use creation time for unstamped legacy openings.
  Retire a cached content signature when a live summary replaces its row.
  Encoded in the real worker-to-renderer recovery cases in
  `cloud-transcript-hydrate.test.ts`, stale-provenance cases in
  `transcript-leading-prompt.test.ts`, and worker session-store regressions.
