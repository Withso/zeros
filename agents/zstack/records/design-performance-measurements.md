# Design performance measurements — 2026-10-27

Status: implementation and regression protection are reviewed locally; full
numerical performance acceptance is **not established**. The owner requested
ending native performance iteration and delivering the reviewed PR with the
remaining budgets recorded. Do not describe this as an overall 100× speedup,
zero-latency rendering, or a current-build acceptance pass.

Mode: single session, GPT-6; no delegated agents. Design remains available for
Personal Local and organization-owned Local workspaces. Cloud Design remains
unavailable; compatibility fixtures grant no owner authorization.

## Reference machine and method

Apple M4, 16 GiB RAM, macOS Darwin 25.3.0, Electron 43.8.3,
Chromium 150.0.7871.250; 60.0024 Hz display, 1440 × 1000 viewport, DPR 2.
Qualification uses optimized production assets and a compiled engine in an
unpackaged isolated Dev profile, without HMR, mock Keychain or disabled
background scheduling. It does not qualify release packaging.

Memory is sampled physical footprint for the app, GPU, renderers, engine and
observed descendants, tracked by process start identity through retirement.
It is not RSS, JS heap or encoded-cache size. Input latency and frame intervals
use Chromium presentation records, not rAF counts or optical latency.
Opening readiness includes driver observation; it is not first-pixel latency.

## Last complete 100-cycle workload

The v136 run finished on 2026-10-26 at 21:56:24 UTC with source digest
`9136ce3ab5037ecca3df8df520f5d72d598134315e7ebcffb94ce01d3fc0c597`.
It covered 100 Personal/organization Local round trips, Design suspend/return,
ten source-change/restore cases, cache pressure and native hide/show. All three
paired visible/hidden idle observations exceeded 60 seconds.

| Measurement | Recorded result | Target | Result for this build |
| --- | --- | --- | --- |
| App + engine sampled peak | 2.200435 GiB | ≤2.5 GiB | Met |
| GPU sampled peak | 638.220169 MiB | ≤768 MiB | Met |
| Fixed warm median | 1.234216 GiB | ≤2 GiB | Met |
| Largest settled block median | 1.237848 GiB | ≤2 GiB | Met |
| Maximum retained growth | 0.294250% | ≤5% | Met |
| Worst incremental visible Design CPU | 0.133664 percentage points | <1 percentage point of one core | Met |
| Hidden optional jobs | 0 in every paired observation | 0 | Met |

Visible/hidden CPU pairs were 2.101147/2.630816%, 1.946677/1.813013%, and
2.125330/2.572340%. Deltas were −0.529670, +0.133664 and −0.447010 percentage
points. Negative samples are observation variation, not proof of CPU savings.

| Gesture / repetition | Input-to-present p95 (ms) | Frame p95 / p99 (ms) | Partial / dropped frames |
| --- | --- | --- | --- |
| Pan 1 | 35.079 | 16.667 / 16.667 | 0 / 0 |
| Pan 2 | 37.619 | 16.667 / 16.667 | 0 / 0 |
| Pan 3 | 41.877 | 16.667 / 16.669 | 0 / 4 |
| Zoom 1 | 53.458 | 16.667 / 16.677 | 89 / 4 |
| Zoom 2 | 51.769 | 16.667 / 16.669 | 89 / 3 |
| Zoom 3 | 39.306 | 16.667 / 33.333 | 0 / 5 |

This run failed zoom latency, partial-frame and frame-time acceptance. Keep the
targets unchanged: input p95 <50 ms, frame p95 ≤16.7 ms, frame p99 ≤33.3 ms,
and no partial frames. 33.333 ms does not pass by rounding. Later camera
changes have not repeated this full soak.

## Later production diagnostics

The v159 diagnostic used source digest
`20d348a131c1b8369e02fd27250f11c0b6b63e9158410624209c8e62b49961e5`
and finished on 2026-10-27 at 02:00:47 UTC. All three gesture pairs completed
with zero partial frames, but timing still failed:

| Gesture / repetition | Input-to-present p95 (ms) | Frame p95 / p99 (ms) | Dropped frames |
| --- | --- | --- | --- |
| Pan 1 | 52.578 | 33.332 / 33.333 | 3 |
| Pan 2 | 51.169 | 33.332 / 33.333 | 0 |
| Pan 3 | 42.710 | 16.667 / 16.667 | 0 |
| Zoom 1 | 52.460 | 33.332 / 33.333 | 4 |
| Zoom 2 | 58.213 | 16.667 / 16.668 | 0 |
| Zoom 3 | 56.031 | 33.332 / 33.333 | 0 |

Sampled app/GPU peaks were 2.041635 GiB / 733.657692 MiB. This diagnostic
omitted the soak and idle phases; its peaks cannot replace the full workload.
The 256-frame readiness observations were about 4.32 s cold and 315 ms warm;
Personal/organization Local warm observations were 178/172 ms. These are driver
readiness observations, not input latency.

The latest candidate coalesces continued native zoom paints while preserving
the immediate first response, ordered deltas and cursor anchors. Its native
source digest was
`6ffdd9e611327267880edd5abace6e49fc997fa4207c92b49fee2a38fc13639c`.
The v164 diagnostic lost foreground ownership after two gesture pairs; zoom
p95 was 57.070 and 64.208 ms, and one pan had insufficient camera samples.
Later foreground diagnostics produced no complete gesture set. They do not
establish a latency improvement for this candidate. The final diagnostic
stopped during setup. All observed native processes were verified retired and
the external overlay's prior visibility was confirmed.

A Linux Chromium regression reduced compositor backing from 134,156,360 to
3,194,296 pixels at the tested overview scale (about 42×). This is a backing
pixel result, not a native RAM or overall performance ratio.

## Reproduction, diagnostics and future work

`pnpm electron:local` starts the checkout's isolated Local development app.
Generate disposable source with
`bun scripts/design-performance-fixture.ts --frames 256 --layout grid --output <new-directory>`.
The owner fixture and production workload are documented in the
[performance playbook](../playbooks/performance.md). Account-free Local mode
pins Personal and cannot qualify organization switching. Never seed, replace
or delete a normal user profile to prepare a benchmark.

Recover `pnpm design:performance:native --status` before another launch. Use
`pnpm design:performance:native --source-digest <verified-sha256>` for the full
workload. A lost result leaves execution unknown. Foreground loss invalidates
gesture coverage; never ignore an unrelated overlay while sending input.
Preserve failed runs and verify every observed process has retired. Native
failure reports now retain a bounded helper reason instead of the entire
serialized input sequence, so command readback remains recoverable.

Resources and Copy diagnostics include app, renderer, GPU, engine, provider
and PTY descendants; per-process CPU/memory and sampling provenance; system
pressure/swap/thermal context; and scrubbed recent logs. Bounded
`[Zeros resources]` history samples the full owned tree every ten minutes and
on Copy, even with the popover closed. Independent cumulative CPU windows do
not borrow an inspector poll's baseline. Missing readings remain unknown;
the cheap Electron-only summary is not full-tree evidence. History contains
no argv, environment values, page titles or workspace names. Other Zeros
instances are reported separately, not charged to this app.

Regression evidence: 1,035 Design tests / 79 suites; 16 camera browser checks;
20 source/vector browser checks covering warm reuse, fidelity and allocation;
64 resource/Copy checks / seven suites; and 197 fast performance checks with
one platform skip. The earlier root run passed 20,977 tests with 22 skipped;
it predates the final small camera/driver edits. The macOS engine smoke passed
with the engine unchanged afterward. Final PR checks and review outcomes
belong in the delivery receipt, not the native measurement claims above.

Remaining work is consistent production pan/zoom presentation and a full soak
on the final interaction implementation. Future modules must retain exact
owner/source keys, bounded caches/queues/processes, cancellation tied to
retirement, and inert hidden surfaces. Extend the workload when adding
rendering, media, fonts, assets or background work. Larger-than-256 documents,
Cloud Design and another rendering backend need separate qualification.
Never inherit a passing CPU/memory claim from an older source digest.

Private evidence remains under `.context/design-performance-targets-2026-10-26/`:
the v136 full report, v159 readback/traces, v164–v168 diagnostic receipts and
regression logs. Raw profiles, paths, identities and traces are not committed
to the public pack.

## Delivery verification — 2026-10-27 03:13 UTC

zstack version: 0.1.7. Mode: single session, GPT-6, following the owner's
instruction to finish review and delivery without further native benchmarking.
Reviewed integration base: `2bf2977b208e6d1be3c75e90bbc6b12d37bbd944`.
Final reviewed source manifest:
`e0a18f39825f8e98eeaaf1e6d21539eabc54e1984a09d082eb825f889d85f8db`.
This identifies the local verification below, not a new native measurement.

The complete Review Agent / zstack-review pass found two P2 issues in older
qualification drivers: hidden cleanup rejected intentional warm caches, and
passive owner visits / baseline sampling required an editor iframe. Both were
fixed. Read-only source provenance now checks the current native authority and
generation; hidden cleanup rejects active work while bounding completed caches.
Authored owner markers remain checked during explicit capture. The follow-up
review found no remaining actionable defect. Native latency acceptance remains
open as recorded above.

- Focused review regressions: 79 passed in five suites. An initial follow-up
  caught the new diagnostic import missing from the optimized qualification
  probe; its export map was corrected before the passing run.
- `pnpm test:git` across the adjacent Design renderer, engine, protocol,
  design-web, native-driver and Electron directories: 3,987 passed, 18 skipped;
  357 suites passed, two skipped. Run with CI's `umask 022`.
- `pnpm check:design-performance`: 202 passed, one platform skip, 16 suites.
- `pnpm typecheck`, `pnpm lint`, `pnpm check:ui`, `pnpm build:ui`,
  `pnpm design:docs`, preload, Electron hardening, packaging paths, deep-link
  schemes, runtime pins, Vite environment, Cursor ASAR and license checks passed.
- `pnpm check:secrets`: 7,449 tracked files passed. CI selection includes the
  full path-selected lanes and all browser shards through `ci:ui-smoke`.
- Strict zstack eval validation: 302 valid cases. Historical replay is not
  claimed for this unmerged change.
- `pnpm check:protocol` returned its advisory exit 1 for the compatible optional
  `apiKeySource` field. CI explicitly marks this heuristic advisory; no required
  wire field changed and the protocol version was not raised to silence it.

Local delivery logs are in `.context/design-delivery-2026-10-27/` in the
integration checkout. Earlier full-root, browser-shard and macOS-engine evidence
is recorded above with its limits. Final CI and merge state belong to the
latest head of [PR #695](https://github.com/Withso/zeros/pull/695); this receipt
records local verification before that delivery commit.

### CI fidelity-test follow-up

The first delivery head, `2449e55d25fa445b93d0f8e0d09b60cee9f662ac`,
passed the browser, macOS and security checks. Both attempts of
[CI run 40443340421](https://github.com/Withso/zeros/actions/runs/40443340421)
failed the same HTML/SVG pixel case with 285 different pixels. The retry did
not resolve that failure.

An isolated fontconfig setting reproduced the exact 285 pixels locally:
slight hinting with RGB subpixel rendering enabled. The HTML reference used
LCD text antialiasing while the SVG image used grayscale. Disabling LCD text
in the comparison browser produced zero differences in all six repetitions;
re-enabling it restored all 285 differences. The whole surface suite then
passed 43 tests with the previously failing fontconfig setting and its
original pixel threshold unchanged. This test-only change does not alter
application rendering or establish another native performance result. The
CI playbook now records this environment distinction.

## Canvas performance pass — 2026-11-07

Mode: co-masters (Claude Opus 5.5 renderer + measurement; Claude Opus 5.5 max
limits + engine scale), no subagents. Reference machine as above (MacBook Air
M4, 16 GiB, macOS 26.3.1, Electron 43.8.3, Chromium 150), but measured while
the owner kept working: built-in 60 Hz display, DPR 2, 1440 × 900 window,
memory pressure with 9.7–9.9 GiB of swap in use, `BTLEServer` near one core.
Treat absolute numbers as this machine's working state, not a quiet lab.

Harness: a local CDP driver (not committed; evidence under `.context/bench/`)
builds the optimized renderer and compiled engine with the native workload's
helpers, launches an account-free Local profile in a floating window visible
on all Spaces, and records per-process CPU/physical footprint, Chromium
presentation traces and memory-infra dumps. Fixtures: the repository's own
`Zeros - Design` page (37 frames), the 256-frame grid, and a 26-page × 1,000
replica of the real frames from #885's fixture generator.

Lessons that changed the method:
- 120 Hz `Input.dispatchMouseEvent` wheel injection queues behind DevTools
  acknowledgements. A trivial page also capped near 35 fps with ~85 ms
  input→present, so early "30 fps" results were partly the harness. Chromium's
  `Input.synthesizeScrollGesture`/`synthesizePinchGesture` (vsync-aligned,
  Telemetry's smoothness input) gives a trivial page 60 fps, 0 dropped and
  ~33 ms input→present. This Mac's swap→presentation floor is 21–23 ms.
  Native CGEvent gestures need foreground ownership, which macOS refuses while
  the owner works.
- An occluded or other-Space window produces no frames; synthetic gestures
  then wait forever. Keep the bench window on all Spaces, check visibility
  before every phase, and treat hidden time as a paused measurement.
- The bench engine lacked the native watch host, so idle engine CPU measured
  the stat-polling fallback (production macOS uses FSEvents through it).
- A peer agent's Conductor message into the measuring chat unbinds the
  owner's Mac from that chat; co-masters coordinate through shared files.

Root causes found and fixed (renderer, PR on branch
`iamarunrk/canvas-performance-optimization-v3`):
- Warm reopen of 256 frames spent 2.82 s of 3.11 s in `getPropertyValue`:
  each source admission read computed style inside a React layout effect.
  Colors now resolve in one batch before composition. Warm reopen
  3,008 → 254 ms; real page 170 → 82 ms.
- Camera paints did O(page) DOM work per frame. With chrome-write skipping,
  tracked hover/focus, bounds-first hit testing and pan-only prefetch
  throttling, the 256-frame pan improved (3 reps): p99 frame 66.7 → 33.3 ms,
  partial frames 38 → 0, dropped 2 → 1, renderer CPU 35 → 22%, total
  CPU 47 → 35%.
- Input-driven main frames started mid-interval; a gesture frame clock keeps
  them on the display cadence while a gesture is live.
- On large pages the preparation lane prepared every mounted frame and
  re-rendered the page mid-gesture. It now yields to live gestures, prepares
  the frames nearest the camera center first, and demands at most the
  source-surface admission limit.
