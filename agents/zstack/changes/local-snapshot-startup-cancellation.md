# Local snapshot startup cancellation

Symptom: reopening the app left a completed chat with “No confirmed workspace
snapshot is available” beneath its transcript.

Cause: a Local connection transition retired an in-flight workspace list. The
aggregate discarded its response correctly, but replaced the cancellation with
an untyped missing-snapshot error. Agent reattachment classified it as terminal.

Rule: preserve lifecycle cancellation through aggregate reads; a cold cache is
not a provider failure. Independently confirmed cloud data may still publish.

Encoded in `local-list-races.test.ts` (startup, reconnect, both Local owners,
cloud independence and real errors) and `transcript-bind-presentation.test.ts`
(the real bind callback retains history and provider binding with no error).
