# Failed prompt receipts must include durable failure history

Symptom: the cold-start inbox regression sometimes observed a failed outcome
before its error notice appeared on disk.

Cause: turn completion fsynced and published the terminal inbox entry, waking
the HTTPS reporter. The fallback notice was folded afterwards through the
debounced stream path. A crash in that interval could permanently lose it.

Rule: commit the user row, failure notice and terminal state in one durable
snapshot before publishing the outcome. Poll disk for asynchronous persistence
assertions, and hold the actual write while exercising an independent reporting
hint to prove the outcome cannot overtake it.

Encoded in the worker's `prompt-inbox.test.ts`: cold-start and provider-turn
failures hold the notice write, then inspect disk at the outcome boundary.
The existing provider-notice case keeps actionable errors intact. Local
Personal and organization-local send paths are unchanged.
