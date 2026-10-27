Symptom → The native renderer had strong correctness coverage, but that did
not establish production frame timing, incremental idle CPU or a sustained
memory plateau. An earlier GPU incident also showed why small RSS/cache
counters were insufficient.

Cause → Correctness, source retention, synthetic input counts, different build
modes and physical memory observations were easy to conflate. Current-source
quantitative acceptance and a reusable workload were missing.

Rule → Keep source/build identity and actual measurement type attached to each
claim. Qualify presentation endpoints, paired unprofiled idle CPU and a fixed
warm-baseline 100-cycle soak. Treat missing evidence and budget failures as
failures, retain every repetition, and require new resource-owning features to
extend the workload before increasing capacity.

Encoded in → `agents/zstack/playbooks/performance.md`, `zstack-verify`,
`scripts/design-performance-budget.mjs` and its regression suite,
`scripts/design-native-acceptance.mjs`, production module/asset driver tests,
and the `check:design-performance` command. The existing root Vitest CI lane
executes the fast tests; native measurements remain a separate Mac command.

Review discoveries → An optimized probe lost its exports under Vite's ordinary
app-entry rules, a stale import escaped the smaller build fixture, and
Electron's process list omitted engine descendants. The actual build regression,
driver-import contract and process-tree/reparenting regressions now cover these
failures. The acceptance checker also rejects a soak missing source changes,
pressure or whole-app suspension, and refuses a pass before native retirement.

Native startup also exposed an eager namespace export turning a valid module
cycle into a production initialization error. A retained optimized-build/browser
regression exercises that cycle; the probe now exposes only the driver's named
live bindings through deferred getters. A successful build must also be opened.

The first owner-switch attempt used account-free Local mode, which correctly
pins the owner to Personal. The benchmark now uses ordinary Dev authorization
with a fresh workspace profile, confirmed `/v1/me` membership, and exact owner
publication before navigation. Admission and acceptance regressions reject
Personal-only mode and missing membership; fixture rows grant no authorization.

Native visibility stayed "visible" after BrowserWindow.hide because Playwright
owned a focus-emulation override. Its owning inspector session must release
that override; a second CDP session cannot. The macOS regression now verifies
real hide/show, and the production workload uses the same helper.

The first interaction workload also dwelt at zoom clamps and serialized CDP
acknowledgements. The bounded input producer, four-leg zoom trajectory and
camera-transform observation have regressions for those measurement mistakes,
transport failure, backpressure and owner replacement. Style writes alone are
not evidence that the canvas moved.

Production traces exposed ignored wheel cancellation and unnecessary camera
inheritance through cached offscreen frame trees. A browser smoke now proves
the active canvas consumes native scrolling while its tool rail remains
independent. Browser regressions cover scoped camera variables, first-return
chrome scale, resized geometry, focus/editing protection and retained-owner
isolation. The camera remains synchronous; cached source elements stay mounted.

Real app hide/show then exposed a missing lifecycle boundary: the selected
Design tab kept 256 display leases after its document became hidden. The
workspace surface now combines tab activity with document visibility before
starting optional work. Completed source images retain their bounded warm
cache; composition and unresolved saves keep their protected ownership.
Browser regressions cover app-hidden retirement, first-frame warm return,
camera preservation, inactive tabs and pending IME/save work. Native acceptance
must still exercise real BrowserWindow hide/show, not a visibility stub.

The soak review found a measurement mismatch: the warm baseline followed the
hidden-document grace, while most cycle samples still included live handoff
allocations. A shared plateau sampler now applies the same grace and ten-sample
window to the fixed baseline and every ten-cycle block. Interaction samples
continue to count toward peak budgets. Regressions reject missing settled
blocks and actual growth; no numerical target is relaxed.

The broad browser run also found a fixture isolation error. The new lazy
catalog persisted a directory owner into the shared page used by older,
identity-free interaction fixtures. It now owns a separate browser context,
with a regression proving it leaves the shared source owner unchanged.

A later idle window contained a guest renderer retirement. Its final cumulative
CPU counter was unavailable, so subtraction across different process sets was
invalid. The driver now retains the interrupted observation and allows one
complete replacement; valid high measurements, root changes and missing/reset
counters are never retried away. Continuous ownership samples also catch a
child that starts and exits between endpoints. The CPU regression suite covers
each case.

Production zoom profiling located synchronous whole-canvas reconciliation when
only visible membership changed. Ready-source visibility now follows the camera
and direct geometry writes; residency publishes only actual source/editor/frame
changes. Browser regressions keep all 256 warm elements stable, check immediate
re-entry, preserve cold layout and protected editors, and exercise owner hiding.
The same diagnostic showed why broad compositor promotion is not a default:
the zoomable world exceeded its GPU shutdown guard. Minimal-control results
remain separate diagnostic evidence and never reduce acceptance thresholds.

The production allocation peak exposed another accounting boundary: the warm
image limit excluded active entries, allowing a newly displayed 256-frame owner
to sit on top of a full inactive pool. Loaded entries now share one retention
budget, enforced at image confirmation and release. Older unleased image
elements yield while exact-generation encoded source stays cached. Regressions
cover byte/count pressure during admission, protected displays and a complete
256-frame Personal → organization → Personal return. Native physical-memory
qualification is still required; encoded estimates do not measure DOM or Skia.

Final review found that shutdown acceptance only checked the app and engine
roots even though resource sampling counted their descendants. The benchmark
now retains observed start identities, waits for helpers after root exit and
reports unresolved retirement in status readback. A subsequent run also checks
those identities before launch. Regressions cover a reparented helper, reused
PID, missing live identity and bounded delayed shutdown. Exiting the parent is
not proof that all work it started has stopped.

The full interaction suite exposed two races that smaller runs missed. An
aggregate child-geometry read published temporary padding positions as resting
gap controls, leaving them displaced after Escape. Reads that start or finish
during a gesture now preserve the confirmed baseline; the browser regression
forces a metadata refresh during padding and checks the restored gap boxes.
A queued text preview could also resolve after document replacement and send
the next preview to the new runtime, suppressing its committed glyphs. Text
edits now retain their original runtime identity for preview and cancellation,
with unit and browser regressions holding a reply across the buffer handoff.
In-place style generations remain supported by that same runtime.

Native profiling also showed hidden overview controls consuming inverse zoom
and relaying layout work on every camera step. Their hidden style now isolates
those variables, with hover and keyboard regressions preserving screen size.
The measured reduction in layout time is diagnostic evidence; presentation
and absolute memory acceptance remain separate requirements. Motion smoke
assertions now observe the scheduled frame before reading coalesced drag
geometry, preserving their exact position and size assertions.

An additional adversarial handoff check pressed Escape after text had saved
but before its replacement painted. Cancellation removed the host glyph owner
early and exposed suppressed outgoing text for a frame. Draft cancellation now
checks both the synchronous commit guard and the editor's settling state; a
started transaction keeps its painted owner until the buffer swap. The browser
handoff regression dispatches Escape at incoming runtime registration and
asserts no blank or duplicate paint. Ordinary draft Escape remains covered.

Initial closeout on 2026-10-26 → The optimized native workload still exceeded pan/zoom
presentation, aggregate peak memory and retained-growth targets. A valid paired idle window
also exceeded its target, with contributions from both the renderer and engine,
despite earlier passing runs and zero hidden optional jobs. Keep every result
and its process breakdown; neither a passed correctness soak nor a prior build
closes a current numerical acceptance failure. Future features inherit these
open budgets and must extend the workload instead of assuming they are met.

The subsequent [measurement record](design-performance-measurements.md) keeps
the last complete 100-cycle CPU/memory results, later gesture repetitions and
remaining timing failures separate from final-build acceptance. It also records
the owner's decision to finish native iteration and proceed with delivery.

The delivery review found two older qualification assumptions left behind by
passive rendering. Hidden cleanup required an empty encoded source cache, and
owner visits / idle baselines required an editor iframe. Shared checks now
permit bounded completed warm pools while rejecting display leases, pending
loads, captures and output scenes. Passive readiness validates the displayed
image's exact native authority and source generation without changing cache
ownership or opening an editor. Owner markers remain checked during explicit
native capture. Browser and cache regressions cover changed authority, stale
source, srcDoc-only fixtures, hidden/missing output and retention bounds.
These tooling fixes do not turn the recorded timing failures into passes; no
additional native run was performed after the owner ended benchmarking.
