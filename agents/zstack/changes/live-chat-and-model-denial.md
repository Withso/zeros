# Live identities, repeated denials and the consumer that reads the cache

- Symptom: a link to a just-created chat stayed a muted "Chat" pill until the
  engine saved the row. Cause: the identity index read only the engine
  snapshot. Rule: admit unsaved store rows through the same owner resolver,
  keeping the saved/live ownership guards.
- Symptom: Cursor fell back from a refused Grok model once, then every later
  turn in the denial window errored. Cause: registry resolution refused the
  cached denial before the retry policy ran. Rule: test first rejection, the
  next turn, create/resume, exact refusal and expiry; keep native eligibility
  separate from temporary denial.
- Symptom: the adapter reported the model unavailable while `zeros local
  models` still offered it. Cause: a replaced adapter catalog never reached a
  previously cached gateway object. Rule: test the public consumer after a
  metadata change (`currentAgentInitialize`), keeping session catalogs private.
- Gotcha: Vitest `mergeConfig` concatenates `test.include`; replace it in a
  scratch config or a probe runs the whole suite.

Encoded in `local-links.test.ts`, Cursor `model-passing.test.ts`,
`gateway-initialize-singleflight.test.ts` and the Local CLI `service.test.ts`
catalog-freshness case.
