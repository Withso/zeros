# Local CLI review: four ways a "once" or "same" claim was false

A review of the Zeros Local CLI found claims the code did not keep:

- **A persisted user message is not the provider input.** Replays, expanded
  attachments and generated instructions travel in the same prompt field, so
  link-sharing read context the person never wrote. Read trusted original text
  (the bubble) and its provenance for anything security-sensitive.
- **Unique event insertion is not once-only delivery.** A note stayed
  `pending` until the provider acknowledged it, so a crash after acceptance
  sent it again. Claim the dispatch durably before native I/O and treat an
  unresolved claim as unknown.
- **A retry cache cannot be shorter-lived than its consumer.** Evicting
  steering receipts after ten minutes re-ran the composer's late retries.
  Keep identities (or tombstones) for the consumer's whole retry lifetime.
- **"Parity" needs differential fixtures.** An engine copy of the picker's
  model rules diverged on canonical ids, partial live lists and retired effort
  tiers while its own tests passed. Compare both implementations on the same
  fixtures.

Also: a standing read (a follow, a long wait) must recheck authority on every
delivery, not only when it was set up.

Encoded in `apps/desktop/src/engine/__tests__/local-orchestration-engine.test.ts`
(bubble sharing, Stop during admission), `local-orchestration/__tests__/service.test.ts`
(restart, pending steer, wait revalidation, note eligibility),
`agents/__tests__/steering-receipts.test.ts` and
`local-orchestration/__tests__/spawn-settings-parity.test.ts`.
