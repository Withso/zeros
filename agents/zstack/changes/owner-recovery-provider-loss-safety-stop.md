# Replay the producer between operator steps

The original recovery tests attested provider loss and then ran the operator
without letting the compute worker observe the 404. That worker can supersede
the queued Restart and create a safety Stop before loss attestation. Exercise
both orders through the real producer and lease settlement, then verify one
atomic receipt accounts for both exact recoveries and all three intents.

Treat an undelivered safety capture separately from the original joined custody.
Late delivery, any custody/report, another successor or unsettled lease must
refuse. Retain SQL controls for partial transitions and stale-worker attempts
to reopen discarded work. Test physical erasure separately from history coverage:
a newly created generation can have no engine yet, while physical erasure still
requires deletion-job custody and the existing provider/data gates.

Immutable evidence cannot be refreshed in place. An expired loss identity may
be reused only with new authenticated observations retained on the discard
receipt. Read outside database locks, revalidate after the await, and make
committed replay independent of provider availability. Run the actual manage
CLI as a password-authenticated restricted login with the stable migration role.
The provider fixture must use the real API envelope, including its success bit.

Encoded in the owner recovery race integration suite and exact migration checks.
