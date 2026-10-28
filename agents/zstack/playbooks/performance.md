# Playbook: performance and new runtime modules

Use this for a performance change or a feature that adds canvas surfaces,
background jobs, caches, native processes, media, or another rendering backend.
Keep the existing Local/cloud capability boundary; Design is Local-only today.
Personal and organization-owned Local must both work, including A → B → A.

1. Name the user-visible workload and resource budget before implementing.
   Separate opening, direct manipulation, source/agent updates, explicit
   capture, warm navigation and hidden idle. Give a new module one lifecycle
   owner, bounded admission/queues/retention, exact source and workspace keys,
   and a cancellation acknowledgement tied to actual resource retirement.
2. Reproduce a measured shortfall before changing the hot path. Profile the
   owning renderer/engine/GPU work. A CPU profiler itself costs CPU; record idle
   acceptance separately with profiling stopped. Preserve the failed evidence.
3. Add a deterministic regression for ownership, stale replies, invalidation,
   cancellation or capacity failures. Use the real producer/consumer boundary.
   Do not test an implementation-shaped helper alone or put timing assertions
   into noisy unit tests. Add the feature's representative workload to native
   qualification before raising capacity or introducing a new backend.
   Test selected-tab inactivity and whole-document visibility independently:
   a selected tab is not necessarily visible. Gate optional work at the owning
   surface while retaining exact-key completed source and protected edits.
4. Run `pnpm check:design-performance` for the fast resource/driver/acceptance
   checks. These suites also run in the existing root Vitest CI lane. They do
   not certify physical GPU memory, energy, FPS or native input latency.
5. On a Mac, first recover `pnpm design:performance:native --status`. A lost
   command result does not authorize another launch. Then run
   `pnpm design:performance:native`, optionally with `--source-digest <sha256>`.
   The workload owns fresh fixtures, an isolated profile and output under
   `.context/design-performance-native/`; it compiles the engine and an
   optimized renderer. The extra qualification entry shares the app's bundled
   stores and is absent from ordinary product builds. It uses ordinary Dev
   sign-in, confirmed organization membership and native Keychain/background
   scheduling. Its new profile isolates workspace data, not authentication;
   no session or credential is copied, and no cloud VM or account is created.
6. Read the report and raw evidence before accepting it. A failed budget exits
   nonzero. Treat missing, short or changed-source evidence as unverified.
   Do not lower a budget or hide a repetition to green a run. Keep the initial
   failure and corrected run, and attribute only controlled changes.
7. Keep feature work within the qualified workload. Changes in fonts/assets,
   prepared content, layout, surfaces, queues, renderer/runtime versions or
   source schemas can change resource costs even without touching the cache.
   Requalify the affected scenario and keep its full app/process measurements.

Keep native subprocess failures bounded and recoverable. `execFile` errors can
embed the entire serialized input workload in their message; report the helper's
short failure reason without its command or cause. Foreground interruptions
remain failed coverage, and a later diagnostic never erases the original run.

The native workload exercises the 256-frame overview and eight other fixtures,
including synthetic retained organization-Local compatibility data. It reports
cold/warm readiness, actual pan/zoom presentation traces, resize cancellation,
external source edits, native capture and cache pressure. After warming the
same workload, it records 100 owner round trips and Design suspend/return
cycles, plus three paired visible/hidden idle observations of at least 60 s.
Every ten cycles also changes and restores source, applies cache pressure and
hides/shows the native app. These cases are required by the acceptance checker.
Authored fixture files must be restored exactly after temporary source edits.
Account-free Local mode pins Personal and cannot prove owner switching. Select
an organization from normal `/v1/me` membership, seed only a fresh stopped
fixture database, then assert exact owner publication before every navigation.
Signed-out or absent membership is a blocked prerequisite, not a reason to
alter the app's admission or install a fabricated membership snapshot.

The policy is centralized in `scripts/design-performance-budget.mjs`:

- At 60 Hz: p95 presented-frame intervals ≤16.7 ms, p99 ≤33.3 ms, and p95
  input-to-presentation <50 ms. Require three repetitions for pan and zoom,
  enough presented/input samples, actual camera changes and no partial frames.
  The roadmap's stricter 16.7 ms warm input-to-paint target remains a distinct
  proposed target; a passing frame interval does not establish input latency.
- Incremental visible Design CPU <1% of one core, compared with hidden Design
  on the same quiescent app. Inactive optional work must be zero. Report every
  observation and process; a main-renderer JS profile alone misses native work.
  A guest retiring during an observation invalidates its cumulative CPU delta.
  Preserve that window and allow one full replacement; never retry a valid
  high result. Root process changes or missing/reset counters fail immediately.
- After warm-up, settled memory medians after each ten-cycle block may grow at
  most 5% over the fixed pre-soak median. Both boundaries use the same 11 s
  retirement wait and ten readings one second apart. Navigation samples still
  count toward peak memory; do not compare live handoff allocations with a
  quiescent retained baseline. The initial targets are 2.5 GiB app/engine
  sampled peak, 768 MiB GPU sampled peak and 2 GiB settled app/engine memory.
  These are acceptance targets to qualify on reference hardware, not proven
  results, cache limits, OS quotas or a promise for every authored document.
  The independent 3 GiB app / 1.5 GiB GPU shutdown guard protects the test host;
  being below it does not establish acceptance.

Presentation comes from paired Chromium PipelineReporter and EventLatency
records for the app renderer within explicit workload markers. Synthetic
non-damaging inputs, rAF counts, missing end events and unrelated renderers are
not evidence of displayed frames. Record dropped/partial frames and tail
latency. Browser presentation time is not optical input-to-photon latency.
Opening/source readiness and resize wall time are separate driver observations;
they do not establish first-pixel or editing input-to-presentation percentiles.
The command publishes a pass only after its app and engine have retired.

Keep the input workload moving: a trajectory pinned at a zoom clamp measures
idle gaps, and awaiting each CDP input acknowledgement serially can manufacture
them. Use bounded, paced input, drain outstanding requests and record actual
camera-transform changes rather than style-mutation counts. Native wheel
ownership must also be real: React's passive wheel delegation cannot cancel
Chromium scrolling. Preserve nested controls and remove native listeners when
their retained surface becomes inactive.

Verify actual native hide/show after removing automation focus emulation on
the inspector session that installed it. Disabling it on a second session is
insufficient. The pinned driver has a macOS regression; a driver upgrade must
pass that test before its visibility/idle evidence is accepted. Never override
document visibility or disable normal background scheduling to pass a soak.

Scope camera style inheritance as well as DOM residency. A decoded frame can
stay cached without every offscreen descendant recomputing on each wheel.
Keep nearby labels/handles and editing/focus protected, use current drag/resize
geometry without synchronous layout reads, and restore camera-dependent chrome
before the returning frame paints. Do not trade keyboard access or sharp,
stable selection geometry for lower style cost.
Camera-only visibility changes must not reconcile all cached frame trees when
their source/editor residency is unchanged. Paint the ready-source visibility
gate with camera and direct geometry writes; cold documents still need layout.
Test immediate return with the same loaded elements and real editor admission.
Hidden overview controls must stop consuming camera-dependent dimensions as
well as hiding their paint. Restore screen-sized controls on hover and keyboard
focus in the same style update; measure the whole interaction before accepting
the optimization. A lower layout cost alone is not a latency pass.

Keep provisional editing geometry out of confirmed selection state. A read
started during a gesture stays provisional even if it resolves after Escape;
retain the pre-gesture geometry until an authoritative refresh. Bind queued
text previews and cancellation to the actual runtime that began the edit, not
only a reusable workspace/frame key. A mounted runtime can adopt a style
generation in place, while a replacement runtime must reject the old edit.
Hold replies across replacement in browser regressions. For coalesced pointer
gestures, check geometry at the scheduled animation frame; an immediate driver
read can race that frame and is not input-to-presentation evidence.
Escape cancels a text draft before saving starts. Once its transaction starts,
retain the painted text through the displayed-buffer handoff, including Escape
before React has published the committing state and during settling.

Hold source writes while exercising repeated duplicate, duplicate → Delete →
Delete, and immediate transfer → edit. Resolve semantic input order, not the
last React render or an outgoing runtime. For scoped acknowledgements, verify
through the real producer and consumer that unrelated HTML is not prepared,
retained covers do not authorize edits, and late preparation cannot overwrite
a newer mutation epoch.

Charge displayed and inactive loaded images to one retention pool. Counting
only inactive images lets a destination add a full working set on top of a full
warm cache. Reclaim older unleased images when a new display is confirmed,
preserve their encoded source, and never evict a displayed image to satisfy an
optional cache limit. Test a full 256-frame Personal → organization → Personal
return within the shared budget as well as pressure beyond that capacity.
Qualification must distinguish retired display work from bounded completed
cache entries. Prove passive source ownership without selecting an editor or
acquiring a cache lease; those actions change the workload being measured.
Keep authored-marker and pixel-fidelity checks in the explicit capture phase.

When latency has a large non-JavaScript component, compare a minimal moving
control in the same host before attributing it to the canvas. Report its result
without subtracting it from acceptance or weakening the target. Test compositor
promotion under the memory guard: a large zoomable world can increase GPU
allocation even when pan becomes faster. A faster trace alone cannot justify it.

Build and open the actual qualification entry: Vite can strip unused exports,
duplicate stores or eagerly read a circular binding even when source-level
import tests pass. Expose explicit live bindings after module initialization.
Sample owned engine descendants as well as Electron's process list, retain
observed orphan identities, and fail on missing live physical-memory readings.
Retirement must verify every observed process identity, including reparented
helpers, before reporting completion or admitting another run. Exited app and
engine roots alone are insufficient; distinguish a reused PID by its start
identity and keep missing live identity unverified.

Receipts retain source/build identity, hardware/RAM/OS, Electron/Chromium,
viewport/DPR, warm-up, resource samples, raw traces, repetitions and limits.
The native command uses an unpackaged Local host with production assets and a
compiled engine; release packaging/signing/updater and minimum-memory hardware
need their own qualification. Its report is unsigned engineering evidence;
required repository CI remains the merge authority.

Keep larger document capacity, Cloud Design and new rendering backends as
explicitly scoped projects. Never infer total RAM from a small encoded cache,
reuse an older architecture's soak as current proof, pin every visited surface
indefinitely, or claim an overall multiplier without comparable measurements.
