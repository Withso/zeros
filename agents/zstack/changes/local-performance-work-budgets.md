# Local performance: bound retained work without delaying interaction

Symptom: local workspaces accumulated large file/diff payloads, repeated Git
summary subprocesses, and agent notification backlogs while minimized. Design
selection and version checks also built frame CSS they did not use.

Cause: entry-count limits ignored payload size; concurrent summary consumers
did not share identical inputs; animation frames were the only buffer drain;
stderr copied every resident session once per line; one identity caller omitted
the existing identity-only render option.

Rule: keep active exact-key snapshots and immediate controls, then remove
duplicate work and bound inactive retention. Share only running Git inputs,
with owner/checkout identity and mutation invalidation intact. Reserve one
oversized warm payload so a large hover cannot evict all ordinary files. Keep
content paint-aligned with a fallback drain, and process permission/settle/exit
events without waiting for paint. Identity checks must use the same generation
as rendering without compiling frame CSS.

Encoded in `has-workspace-changes.test.ts`, `workspace-file-data-cache.test.ts`,
`keyed-async-cache.test.ts`, `agent-notification-flush.test.ts`,
`agent-update-flush-scheduler.test.ts`, `sessions-store-stderr.test.ts`, and
`style-sources-render.test.ts`. The provider tests execute the production
listener effect and real store across Personal Local, organization-local and
cloud ownership. Cloud cache policy stays separate from Local byte pressure.

Measurement lesson: app process-tree diagnostics include agent verification
children. Separate TypeScript/Vitest/build memory from steady-state app usage;
run heavy checks serially during a live responsiveness investigation. Report
fixture latency and modeled payload retention as such, not as measured
whole-app CPU or physical-memory savings. Linux `/proc/self/fd` cloud tests
fail on macOS even on the unchanged base; preserve those results as a platform
limitation rather than weakening their descriptor checks.

Renderer follow-up: memoized children still render when their parent allocates
new render functions, callback closures or context collections per chunk. Move
each turn behind its own memo boundary, preserve unchanged collection values,
and route event callbacks through the latest committed closure. Tail-only state
must still update the live turn; owner changes and permission state must still
reach every consumer. `ui-smoke-transcript-render-scope.mjs` checks settled-turn
render scope for Personal Local, organization-local and cloud chats.

Incremental text segmentation needs a proven restart boundary, not merely the
last revealed UTF-16 offset. Several chunks can arrive before the next paint
and extend that offset into a larger grapheme. Completing a trailing high
surrogate can also change the code point category and remove an earlier
boundary, including regional-indicator pairing. The review caught both cases;
`streaming-text-buffer-bursts.test.ts` retains them alongside the segmentation
cost and Unicode tests. Exercise burst delivery as well as one push per frame.
Report development React timings, sampled JS heap capacity, and process
footprint separately; post-GC heap differences do not prove data equivalence.
