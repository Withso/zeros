# Sidebar filters and update ordering

- Symptom: filtering a mixed cloud workspace list could keep rows from an
  excluded repository. Cause: cloud folder resolution uses the complete catalog,
  independently of the caller's project subset. Rule: recheck resolved project
  identity against the filtered set. Encoded in
  `shell/__tests__/sidebar-workspace-model.test.ts`, using real cloud catalog
  documents for all three groupings.
- Symptom: nested-folder activity advanced the parent's sort clock. Cause: a
  first-prefix match is not semantic ownership. Rule: pick the most-specific
  registered workspace while preserving path normalization. Encoded in
  `shell/__tests__/sidebar-workspace-activity.test.ts`.
- Symptom: Arrow Down from a submenu search immediately returned to the input.
  Cause: Radix can reattach a composed ref on focus changes. Rule: apply initial
  autofocus once per mounted content node. Encoded in the browser assertions in
  `scripts/ui-smoke-sidebar-filters.mjs`.
- Symptom: account switching erased saved cloud repository filters, and deleting
  one account's repository affected another account. Cause: an empty runtime
  catalog was treated as durable deletion. Rule: preserve preferences on account
  retirement and scope confirmed deletion by account/organization. Encoded in
  `state/__tests__/cloud-workspace-catalog.test.ts`.
- Symptom: first attachment to a cloud worker looked like recent workspace
  activity. Cause: catalog placeholders do not carry worker metadata. Rule:
  retain row provenance through shared-cache equality and compare metadata only
  after both snapshots are confirmed. Encoded in
  `state/__tests__/cloud-workspace-catalog.test.ts`.
