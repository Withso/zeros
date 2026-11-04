# Derive orderings only from facts later writes cannot rewind

The first Pro-seat queue dated "when Pro ended" from `updated_at`, `valid_from`
and `valid_until` at read time. An independent review showed that ordinary
writes — a future-dated grant, recording that an expired grant ended, a
backdated window — reordered the queue and put members who already held a free
seat on Hold.

Rule (review checklist, concurrency and time): when an order or priority depends
on when something happened, record that moment where later writes cannot move
it earlier (0216's `account_entitlements_record_pro_end` trigger keeps
`pro_ended_at` monotonic) and test the writes that are not the event itself, not
only the event.

Held by `organization-seats.integration.test.ts` ("never lets a later
entitlement write move a member ahead…") and the 0216 contract in
`src/migrations.test.ts`. The fragment carries the general rule to the review
checklist.
