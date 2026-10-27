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
- Symptom: CI still expected 30px rows after the approved 32px change. Cause:
  shared Surface equivalence tests also pin the sidebar recipes. Rule: trace
  geometry contracts beyond the shell suite; keep
  `shared/ui/primitives/__tests__/surface.test.ts` aligned with approved layout.
- Symptom: folder smoke scenarios timed out looking for the retired grouping
  menu labels. Cause: multiple feature scenarios share the sidebar controls.
  Rule: search all smoke callers when changing a control's label or role, and
  retain their behavioral assertions across every supported grouping. Encoded
  in `scripts/ui-smoke-folder-workspace.mjs` and `scripts/ui-smoke-folder-review.mjs`.
- Symptom: a local browser comparison loaded two optimized React copies and
  failed before the changed interaction. Cause: concurrent checkout servers
  shared a dependency cache. Rule: give comparison servers separate Vite
  `cacheDir` values and restart a stale server before interpreting browser
  failures. A fresh cache passed all three folder scenarios unchanged.
