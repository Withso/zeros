# Intent prefetch must not mint expensive server generations

Symptom: the Electron main process sat at 40–100% CPU while agents worked,
with all four libuv workers in realpath/scandir.
Cause: composer pointer and focus intent called the @ refresh path, which
minted a new filesystem revision after 2 s and subscribed to later file
changes. Each revision is a full workspace walk (node_modules included); an
agent's file writes then re-walked the tree on every refresh-bus event while
the menu was closed.
Rule: intent warming is a one-shot read of the current generation with a reuse
window. Only a visible consumer subscribes to invalidations, and a
revalidation window must match what a regeneration costs, not a cache age.
Encoded by: mention-files-cache.test.ts (prefetch neither subscribes nor
mints revisions; open-menu window).
Also learned: a walker's contract lives in its callers' suites too. Skipping
`.git` or resolving a missing root to [] broke workspace-files.test.ts, which
pins both (mentions include `.git/HEAD`; an unavailable root rejects). Search
every suite that reaches the changed function before changing its output.
Proposed target: docs/ui-interaction-performance.md, intent warming.
