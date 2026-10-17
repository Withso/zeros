# Local empty-chat transcript row

Symptom: an empty Local chat's provenance block (workspace rows or "Add chat
transcripts") disappeared and left a blank transcript, and a prompt sent in a
sibling chat reached the empty chat's row only after a noticeable delay.

Cause: each empty chat read its own (folder, excluded chat) list, and the
block rendered nothing until that read answered. A busy or still-starting
Local engine held it for seconds, and every new or remounted tab started cold.
A sent prompt showed only after the engine's change broadcast, the row's
400 ms re-pull debounce and another read.

After a restart an empty chat was worse: empty windows are never cached, so
it showed "Loading conversation…" and no block until the engine started.

Rule: never gate a visible empty state on a read without a bounded fallback.
Local folders share one list (each chat filters itself), persist it as
paint-only data that is revalidated once per launch, and overlay prompts this
renderer sent until the engine confirms them or two minutes pass. Workspace
rows stand in after a 400 ms grace. Remember known-empty Local chats across
launches and paint their empty state provisionally; drop the mark at the first
message or history hint. A retained hidden sibling legitimately
renders its own empty state from the shared list, so browser checks must be
scoped to the visible pane.

Encoded in `chat-transcript-summaries.test.ts`, `fresh-local-chats.test.ts`,
the known-empty cases in `local-transcript-hydrate.test.ts`, the
`chat-provenance-style.test.ts` and `composer-responsive-contract.test.ts`
contracts, and `scripts/ui-smoke-transcript-row.mjs`.
