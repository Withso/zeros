# Canvas structural command ordering and acknowledgement cost

- Symptom: nested deletion resolved a stale frame, rapid duplicate commands
  disappeared, and a destination's outgoing runtime caused a loading refusal.
  Cause: rendered selection and busy flags stood in for semantic input order,
  and runtime existence stood in for exact-generation readiness. Rule: hold
  source writes while exercising repeated copy/delete and destination handoff;
  resolve the latest semantic target and await exact authority. Encoded in
  `design-node-actions.test.ts`, `design-frame-runtime.test.ts`,
  `design-layout-transfer.test.ts` and `ui-smoke-design-copy.mjs`.
- Symptom: a one-frame acknowledgement prepared unrelated HTML; subtree copy
  and identity repair grew quadratically. Cause: aggregate snapshots after
  every edit and repeated whole-string splicing. Rule: measure preparation and
  source assembly separately from presentation, and test scoped replies through
  the real service and renderer. Encoded in `navigation-preparation.test.ts`,
  `workspace/__tests__/service.test.ts`, `design-workspace-preparation.test.ts`
  and `packages/design-web/src/__tests__/html.test.ts`.
- Review found that Delete before a copy acknowledgement could remove the
  original, and structural adoption could reorder a style-before-copy
  transaction. Held-write browser regressions retain both failures; an
  operation-order regression requires fallback whenever projection cannot
  mirror source semantics. Source stress timings and browser continuity are
  recorded separately from native performance qualification.
