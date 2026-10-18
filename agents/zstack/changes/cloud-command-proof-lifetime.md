Bind asynchronous command authorization to the RPC and socket lifetime.

- Symptom: adding native signing to a synchronous socket send could dispatch a
  command after its caller timed out, cancelled or replaced the connection.
- Cause: the RPC timer ended the request while a separate proof promise still
  held the unsigned command and could send its late result.
- Rule: keep a bounded ordered command queue, tie native preparation to the
  request's cancellation signal and exact native attempt, and recheck authority
  after every signature. A failed proof is never an unsigned retry. Keep bulk
  transport on its existing path and return only the complete bound envelope.
- Encoded in the native accepted-work, SDK command sender, renderer IPC and
  open-cloud-runtime-sdk tests, with Local Personal and organization-local
  transport controls. Fresh nonces, funding scope and token rotation have
  cryptographic and deferred-signature regressions.
