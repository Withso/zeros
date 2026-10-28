Provider API key detection in Settings

- Symptom: an agent could run with an inherited API key while Settings said no
  key was configured. Cause: the engine selected saved or environment credentials,
  but Settings treated the native saved slot as the entire authentication state.
  Rule: publish only safe source metadata from the same selection used by the
  engine; keep presence, authentication rejection and the ability to remove a
  saved key separate. Preserve subscription selection and channel isolation.
  Encoded in gateway-api-key-source.test.ts and runProviderApiKeySourceSmoke.
- Symptom: a failed first credential read looked like a confirmed absence.
  Cause: the presence boolean started false. Rule: retain an unknown state until
  a successful read, keep confirmed presence on refresh failures, and ignore
  stale reads after hidden-surface cleanup. Encoded in the provider settings
  browser regressions for held, failed and shared-store reads.
- Symptom: a shared key changed while Settings was hidden still showed a
  disconnected connection on return. Cause: the registry's freshness window
  outlived the hidden surface's credential subscription. Rule: revalidate on
  reveal through the shared refresh flight, retain confirmed content, and start
  no reads while hidden. The browser regression holds an old absence read across
  hide/reveal, then verifies the replacement key survives its late reply.
- Browser fixtures that replace a fake engine must invalidate the preceding
  fixture's persisted registry before mounting the real Settings surface.
  Otherwise a fresh credential fixture can reuse another fixture's cached source.
- A hidden-account usage assertion depended on a background registry read to
  repaint a surface whose cache observer was intentionally paused. Assert the
  native event reaches the cache while hidden, with no registry or usage reads,
  then assert the exact account on reveal. This preserves the stale-reply test
  without requiring hidden work to make it pass.
