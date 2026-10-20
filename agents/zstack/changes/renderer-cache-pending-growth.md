# Renderer cache growth behind held I/O

Symptom: settled-cache checks passed, but an older pending read allowed every
newer completed preview to remain resident. Browser profiling reproduced this
with eight mounted cloud chats; ordinary switch/hide cycles plateaued.

Cause: the LRU completion-order exception stopped eviction without checking
the size or payload allowance. A pending request became an exemption for
unrelated completed data.

Rule: bound inactive completed retention while I/O is held, preserve current
subscribers and request identity, and prune again on release. Profile mounted
surfaces as well as stores; keep the browser/Mac and heap/RSS distinction.

Encoded in `keyed-async-cache-growth.test.ts`, the offline renderer memory
harness/CDP driver, `renderer-cache-pending-growth` and
`docs/ui-interaction-performance.md`. The snapshot reader streams large
numeric tables so profiler output does not exceed Node's single-string limit.

Measurement lesson: Playwright/CDP handles are heap roots. Dispose readiness
handles and use locator waits; otherwise the profiler itself retains a chat
subtree after every mount. Compare untouched teardown cycles before sending a
neutral event to distinguish React's last-event target from cumulative growth.
