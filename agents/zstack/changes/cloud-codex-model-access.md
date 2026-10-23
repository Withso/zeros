# Cloud Codex model access and refusal presentation

- Classify the provider's exact wording before HTTP or transport decoration:
  OpenAI says a project "does not have access to model …". Cover the same
  native error in Local and worker classifiers, with auth, rate-limit and
  network precedence controls.
- Presentation and machine evidence are separate. A short actionable failure
  must not remove the native cause needed for model-discovery repair. Exercise
  notification, completion and rejected-RPC paths, including structured RPC
  data. Keep diagnostics non-serialized and test saved legacy notices at every
  chat presentation, rather than just the current producer.
- Discovery is advisory and scoped to the selected credential. Re-check live
  access before a cache hit; coalesce and bound provider requests and response
  allocation. A complete empty list is authoritative; failed, partial or
  malformed discovery is unknown. A replacement credential cannot inherit the
  previous key's list. Keep Local Personal and organization-local controls.
- A unified agent menu also shows inactive providers. Test the actual group
  builder from another agent's chat, not only the currently selected provider.
  Revalidate asynchronously on active cloud menu opens, keep hidden composers
  inert, and prove a pending discovery cannot delay native prompt delivery.

Encoded in `provider-error.test.ts`, the Codex driver/adapter regressions,
`cloud/proxy.test.ts`, worker `model-availability.test.ts`, and renderer
`model-menu-refresh.test.ts`, `refresh-agent-model-catalog.test.ts` and
`turn-failure.test.ts`.
