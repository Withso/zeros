# Playbook: bug fix

Numbers refer to `agents/zstack/principles.md`.

1. **Reproduce.** Capture the exact symptom: a closed error code, a failing
   check or user-visible behavior, with the revision and environment. Reproduce
   it on the surface the user saw before reasoning about causes.
2. **Red.** Write the smallest regression that fails for the stated reason,
   through the real producer and consumer (13). For a race, hold the contended
   condition or inject the delay; never add a sleep and hope (14). When the path
   is shared, cover Local Personal, organization-local and cloud, and A → B → A.
3. **Root cause.** Trace the mechanism to `file:line`. If you can only observe
   the symptom, say so and fix only what the evidence supports. Check the usual
   mechanisms first:
   - a late or failed reply crossing an await, lock or owner switch (1);
   - unknown read as empty, false, deleted or healthy (2);
   - a cache or optimistic row used as authority (3);
   - intent recorded after I/O, or a lost reply turned into a resend (4);
   - a later error, cleanup label or timeout replacing the first failure (5);
   - a deadline extended by a slow phase or lock wait (6);
   - a retry of an untyped or terminal failure, or a zero-delay retry (7);
   - hidden or background work still scheduling (9);
   - a client-side timer or lifetime, checked before blaming a server limit;
   - a consumer, entry point, placement or older reader left behind (10, 11).
   Before calling a before/after snapshot stable, sample the live row for a
   full poll period of every writer that touches it.
4. **Fix** the root cause with the smallest change. Keep compatibility, and keep
   Local and cloud placements correct.
5. **Green.** Run the regression, the whole touched test directories and the
   static gates (`zstack-verify`).
6. **Review** your own full diff (`zstack-review`), then deliver
   (`integrate-pr.md`).
7. **Learn.** If the bug escaped an existing check, add an eval case and
   strengthen that check (`zstack-learn`).
