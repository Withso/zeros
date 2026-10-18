Keep native SDK authority and asynchronous delivery in the same lifetime.

- Symptom: catalog invalidation could share an obsolete admission flight;
  retiring a handle left its renewal request running; an IPC response could
  arrive after the renderer changed accounts.
- Cause: a shared request, native handle and renderer delivery each have an
  independent asynchronous boundary. Canceling only the final socket is late.
- Rule: bind admission flights to the exact decision incarnation, cancel
  retired requests, and recheck account/device/handle ownership after signing,
  issuance and IPC delivery. An expired device session permits one session
  repair, not legacy fallback or an unbounded retry.
- Encoded in cloud-sdk-runtime-broker and renderer cloud-sdk-runtime tests.
  Native proof IPC accepts only a closed field schema and an issued handle;
  Local routing and the disabled capability gate have executable regressions.
