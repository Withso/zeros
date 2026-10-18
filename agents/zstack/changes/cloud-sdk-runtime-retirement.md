Keep runtime authentication, boot readiness and retirement in separate checks.

- Symptom: an SDK route race outlived its caller, a pending renewal waited for
  a socket callback after close, and a queued frame could reach a listener that
  had already retired the connection.
- Cause: socket authentication completes before the engine boot handshake,
  and asynchronous signing and queued messages each retain their own lifetime.
- Rule: cancel all pending routes, clear renewal and queued frames synchronously
  on retirement, and stop draining when a callback closes the connection. A new
  transport still passes the existing exact boot/writer/authority gate before
  commands or native forwarding are enabled.
- Encoded in runtime-session-lifetime and open-cloud-runtime-sdk regressions.
  Local routing/list merging stay unchanged; mixed-version fallback issues one
  native legacy admission before publishing the peer's runtime identity.
- Check the packaged renderer's CSP as well as its socket adapter. The build
  policy must admit the validated direct provider origin; a permissive native
  header does not override a stricter meta policy. Keep the regression beside
  cloud-runtime-csp and never widen the policy to every WSS host.
