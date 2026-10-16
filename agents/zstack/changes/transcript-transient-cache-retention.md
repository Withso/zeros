# Transient history failures must not retire cached presentation

Symptom: reopening or revalidating a conversation flashed Loading despite a
confirmed disk window. A newly created cloud conversation's projection 404
also erased that window.

Cause: the paint race treated every rejected history request as finished before
disk I/O could paint, and classified `cloud_conversation_not_found` as deletion.

Rule: a typed projection miss is not a tombstone. Let an already-started,
exact-owner disk read paint before releasing a failed hydration request. Keep
the read rejected and the window provisional; explicit deletion, restore-head
invalidation and access denial still retire cached content.

Encoded in `platform/__tests__/cloud-transcript-revalidation.test.ts`: real disk
reopen, held disk I/O, transient errors, account A → B → A, denial and sibling
isolation. Existing Local hydration and cache-bound suites remain adjacent gates.
