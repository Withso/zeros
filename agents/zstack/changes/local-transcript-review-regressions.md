# Preserve long-turn recovery and confirmed empty history

Symptom: review found that a failed long Local turn's Retry actions did
nothing, updating its first resident tool removed the opening prompt, and
reset history could reappear from the presentation cache.

Cause: Retry searched only resident message rows; leading-prompt settlement
compared message objects instead of IDs; empty windows bypassed cache
invalidation, including when eviction preceded the delayed capture.

Rule: a confirmed leading prompt participates in explicit Retry ownership
checks, with newer inline prompts, cancellation and workspace changes still
fencing the send. Cached presentation never authorizes recovery. Reconcile a
window's front by stable message ID across updates, trims and prepends.
Invalidate confirmed empty history immediately; cold/loading emptiness is
not confirmation.

Encoded in `retry-agent-turn.test.ts`, `transcript-leading-prompt.test.ts`,
`local-transcript-hydrate.test.ts` (the real hydration and cache subscription),
`local-transcript-cache.test.ts` (memory, disk and restart), and
`docs/ui-interaction-performance.md`. Local Personal, organization-local and
cloud controls remain covered.
