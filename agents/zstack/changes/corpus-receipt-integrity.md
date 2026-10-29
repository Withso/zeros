# A corpus score needs complete per-case evidence

Replay exit 1 can mean a valid missed/unverified case or a missing receipt.
Continuing solely on that exit can silently drop cases; stopping solely on it
prevents the remaining corpus from running. Require the exact batch identities,
status/code pairs, recipe fingerprints, counts and a matching exit before
accepting the batch. Keep partial progress on failure or cancellation.

Compare individual catches as well as the total rate: a new catch must not hide
one that was lost. Compare the same baseline population, including its unverified
cases; report new cases and the whole-corpus rate separately so adding a scenario
does not masquerade as a regression. An unknown
historical revision becoming known is an improvement with an unchanged recipe;
changing a known revision or a seed mutation needs reviewed evidence.

Evidence also belongs to one runner version. If case recipes or runner bytes
change during a long run, fail the receipt rather than blending observations.
Covered by scripts/__tests__/zstack-corpus.test.ts.
