# Local transcript readiness and long-turn prompts

Symptom: Local chats showed "Loading conversation…" on every cold reopen, new
tab and app launch, and a long autonomous turn reopened with no user prompt.

Cause: Local hydration had no presentation copy, so every cold read waited on
the engine, which takes seconds to start (the owner's Mac logged
`Engine ready (13904ms)`). New chats read an empty transcript the renderer had
just created. The engine snaps a tail window to its turn's opening only within
1000 rows, so a longer turn's prompt was outside every window.

A Local engine also rewrote each streaming row on every provider chunk: the
full payload plus its full-text reindex, measured at 0.45–0.9 ms per chunk and
1.26 s for one 32 KB answer, blocking every other engine request.

Rule: Local presentation readiness mirrors cloud's without its fences: paint
the last confirmed Local window provisionally and read-only, keep unchanged
references on confirmation, and start renderer-minted chats resident. A
window that cannot be snapped carries the opening prompt beside its rows;
trims re-derive it. Coalesce streamed rows behind a buffer that every read,
write and delete drains first. Attribute slow engine starts by phase before
guessing.

Encoded in `local-transcript-hydrate.test.ts` (production hydrate callback),
`local-transcript-cache.test.ts`, `transcript-leading-prompt.test.ts`, the
`db.test.ts` long-turn and coalesced-write cases, `service.test.ts`, the extended latency
contract test, `scripts/ui-smoke-local-transcript-paint.mjs`, and the
`[Zeros] slow boot phases` line.

Integration smoke exposed an invalid fixture: an empty `patchSession` derives
`hasTranscript` from the existing slot, so it cannot seed known old history.
Seed the complete session before asserting cold-history presentation, and
pause a previously advanced browser clock relative to browser time instead
of the host clock. The Local transcript paint and transcript-row browser
checks retain the assertions and encode these fixture boundaries.
Use the locator's literal name matcher for prompt text instead of partial
regular-expression escaping; the transcript-row smoke retains its literal
question marks and CodeQL checks the escaping boundary.
