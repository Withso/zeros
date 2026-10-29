# Playbook: performance and new runtime modules

Use this for a performance change or a feature that adds canvas surfaces,
background jobs, caches, native processes, media, or another rendering backend.
Keep the existing Local/cloud capability boundary; Design is Local-only today.
Personal and organization-owned Local must both work, including A → B → A.
Numbers refer to `agents/zstack/principles.md`; 9 and 16 apply throughout.

1. Name the user-visible workload and resource budget before implementing.
   Separate opening, direct manipulation, source/agent updates, explicit
   capture, warm navigation and hidden idle. Give a new module one lifecycle
   owner, bounded admission/queues/retention, exact source and workspace keys,
   and a cancellation acknowledgement tied to actual resource retirement.
2. Reproduce a measured shortfall before changing the hot path. Profile the
   owning renderer/engine/GPU work. A CPU profiler itself costs CPU; record idle
   acceptance separately with profiling stopped. Preserve the failed evidence.
   When a platform workaround replaces an event source with polling, record its
   cost per unit (per root, file or tick).
3. Add a deterministic regression for ownership, stale replies, invalidation,
   cancellation or capacity failures through the real producer/consumer
   boundary. Keep timing assertions out of noisy unit tests. Test selected-tab
   inactivity and whole-document visibility independently: a selected tab is
   not necessarily visible. A performance change keeps the ordering, freshness
   and liveness contracts of the work it removes.
4. Run `pnpm check:design-performance` for the fast resource, driver and
   acceptance checks (they also run in the root Vitest CI lane). They do not
   certify physical GPU memory, energy, FPS or native input latency.
5. On a Mac, first recover `pnpm design:performance:native --status`; a lost
   result does not authorize another launch. Then run
   `pnpm design:performance:native`, optionally with `--source-digest <sha256>`.
   The workload owns fresh fixtures, an isolated profile and output under
   `.context/design-performance-native/`, and compiles the engine and an
   optimized renderer. It uses ordinary Dev sign-in and confirmed organization
   membership; no session or credential is copied, and no cloud VM is created.
6. Read the report and raw evidence before accepting it. A failed budget exits
   nonzero; missing, short or changed-source evidence is unverified. Never lower
   a budget or hide a repetition to green a run; keep the initial failure and
   the corrected run.
7. Keep feature work within the qualified workload. Fonts, assets, prepared
   content, layout, surfaces, queues, renderer/runtime versions and source
   schemas can all change resource costs; requalify the affected scenario.

Native subprocess failures stay bounded: `execFile` errors can embed the whole
serialized input, so report the helper's short reason only. Foreground
interruptions remain failed coverage.

## Workload and budgets

The native workload exercises the 256-frame overview and eight other fixtures,
including synthetic organization-Local compatibility data. It reports cold/warm
readiness, pan/zoom presentation traces, resize cancellation, external source
edits, native capture and cache pressure. After warm-up it records 100 owner
round trips and Design suspend/return cycles, plus three paired visible/hidden
idle observations of at least 60 s; every ten cycles it also changes and
restores source, applies cache pressure and hides/shows the native app.
Account-free Local mode pins Personal and cannot prove owner switching.

The policy lives in `scripts/design-performance-budget.mjs`:

- At 60 Hz: p95 presented-frame intervals ≤16.7 ms, p99 ≤33.3 ms, p95
  input-to-presentation <50 ms, three repetitions for pan and zoom, actual
  camera changes and no partial frames. 33.333 ms does not pass by rounding.
- Incremental visible Design CPU <1% of one core against hidden Design on the
  same quiescent app; inactive optional work is zero. A guest retiring during
  an observation invalidates its cumulative CPU delta: allow one replacement,
  never retry a valid high result.
- Settled memory medians after each ten-cycle block grow at most 5% over the
  fixed pre-soak median, sampled with the same retirement wait. Initial targets:
  2.5 GiB app/engine sampled peak, 768 MiB GPU sampled peak, 2 GiB settled. The
  3 GiB app / 1.5 GiB GPU shutdown guard protects the host; staying below it is
  not acceptance.

Presentation comes from paired Chromium PipelineReporter and EventLatency
records for the app renderer within workload markers; rAF counts and synthetic
non-damaging inputs are not frames. The last recorded results and open budgets
are in `agents/zstack/records/design-performance-measurements.md`.

## Design canvas specifics

- Keep the input workload moving: a trajectory pinned at a zoom clamp, or
  awaiting each CDP acknowledgement serially, manufactures idle gaps. Record
  camera-transform changes, not style mutations.
- Native wheel ownership must be real (React's passive wheel delegation cannot
  cancel Chromium scrolling); remove native listeners from inactive surfaces.
- Verify native hide/show after releasing automation focus emulation on the
  session that installed it. Never override document visibility to pass a soak.
- Scope camera style inheritance as well as DOM residency; camera-only
  visibility changes must not reconcile every cached frame tree.
- Keep provisional editing geometry out of confirmed selection state, and bind
  text previews and cancellation to the runtime that began the edit.
- Charge displayed and inactive loaded images to one retention pool, reclaim
  older unleased images when a new display is confirmed, and never evict a
  displayed image to satisfy an optional limit.
- Build and open the actual qualification entry: Vite can strip exports or
  duplicate stores even when source-level imports pass. Retirement verifies
  every observed process identity, including reparented helpers.
- Receipts carry source/build identity, hardware, OS, Electron/Chromium,
  viewport/DPR, warm-up, samples, raw traces, repetitions and limits. Larger
  documents, Cloud Design and new rendering backends are separately qualified
  projects; never inherit a pass from an older source digest.
