# Saved generations, CSS evidence and retained draft payloads

- **Symptom.** A lingering saved stylesheet could repaint a newer saved frame;
  the inspector could label losing tokens as winners; evicted preview text
  remained reachable beyond the renderer's memory budget.
- **Cause.** Preview handoff did not distinguish document generations or tool
  identities. Cascade resolution skipped nesting, treated container queries as
  unconditional and ignored unresolved inline shorthand longhands. Draft status
  metadata retained duplicate references to the large payloads being evicted.
- **Rule.** Authoritative generations replace advisory previews in either
  save-event order. Authored CSS needs positive cascade evidence; uncertainty
  falls back to computed values. Payload eviction must remove every owned
  reference, including metadata.
- **Encoded in.** `scripts/ui-smoke-design-agent-drafts.mjs` holds retirement
  across new documents before and after tool success;
  `packages/protocol/src/__tests__/design-runtime-authored-styles.test.ts` checks
  browser-computed colors, provenance and token origins;
  `apps/desktop/src/renderer/features/design-workspace/__tests__/design-agent-drafts.test.ts`
  counts retained HTML/CSS throughout the store. The metadata type excludes
  payload fields. `zstack-review` and `docs/design-mode-roadmap.md` record the
  contracts. These defects were caught before integration, so no escaped-bug
  eval case is added.
