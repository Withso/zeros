# Keep offline consistency separate from agent authority

Symptom: a long-lived native task or a self-reported token/session field can be
mistaken for a detached agent qualification. A blanket transcript digest also
rejects legitimate updates to in-flight tool/result rows.

Cause: observation consistency, native completion and authorization are
different boundaries; only some transcript payloads are immutable.

Rule for the next pack fold: an offline proof consumer must require the exact
accepted native terminal and contiguous original replay, retain all baseline
row identities, and digest only immutable settled/user payloads as stable.
It must report authority and live qualification as unverified, keep unavailable
dispatch counts unavailable, and leave owner signing to its reviewed boundary.

Encoded in the new detached-agent-proof contract and its two focused suites;
`seeded-detached-agent-native-event` removes the native replay-completion guard
and must be caught. This is a new offline feature, not an escaped production
authority fix. Existing native soak and signed cleanup semantics are unchanged.
