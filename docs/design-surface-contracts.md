# Design surface identity, hosts, and qualification

This is the Phase 0 decision record. It defines the boundary future adapters
must meet; it does not enable additional surface kinds.

## Identity and compatibility

| Layer             | Current contract                                                                                     | Change rule                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Directory         | Committed `design.toml` ID; private active `directory_id` selection                                  | A replacement ID revokes existing grants and review selections. Directory display names are not authority.              |
| Authored document | Directory ID + `frame:<portable HTML filename>`                                                      | Current frame rename edits its title. Introducing source-path rename or independent surface IDs requires a migration.   |
| Canvas            | Existing canvas v3 and `frame`/`text` kinds                                                          | Unknown versions/kinds fail closed. Do not rewrite a newer document into an older supported shape.                      |
| Foundation        | Existing schema v1 and its forward migration                                                         | Foundation, canvas, bridge, and runtime versions are separate contracts.                                                |
| Source            | Exact semantic revision; separately hashed composed HTML                                             | External edits invalidate apply/undo expectations. A saved capture remains historical evidence for its recorded inputs. |
| Runtime           | Existing iframe protocol v2 and a mounted generation                                                 | A source revision does not authorize a message from a replaced runtime.                                                 |
| Context attachment | Version-1 workspace/directory/frame/optional-node/revision reference | Read-only inspection reports stale/missing/wrong-directory without healing or granting write authority; composer delivery remains pending. |
| Legacy storage    | Legacy directory paths, registry, `.zeros/design/` metadata and `.zeros-canvas.json` remain readable | Migrate through the Design engine. Existing `document.ts` exports and IPC names remain compatible.                      |

A future surface envelope needs a stable opaque surface ID, kind, source
reference, geometry, and portable scenario inputs. Credentials, preview ports,
process IDs and grant tokens stay private. Add it with the first concrete new
kind, versioned recovery fixtures, and a supported unsupported-document path.
Do not ship an empty adapter framework ahead of a caller.

## Lifecycle and admission

Every runtime belongs to one workspace/directory/surface and one generation.
Admission counts pending mounts, displayed instances, replacement buffers, and
cleanup still in flight. An abort request alone does not release a slot.

A replacement keeps the confirmed visible generation until it is ready. Only
the current owner/generation can publish readiness. Deleting/recreating an
owner cannot resurrect an old async completion. Hidden retained content has no
active polling, shortcuts, focus, measurements, or capture loop. Suspension
must stop active work; eviction must also destroy the owned resource.

`node scripts/design-adapter-prototype.mjs` exercises this contract with inert
adapters: unknown kinds, replacement-slot exhaustion, cancellation, late
readiness, deletion/recreation, independent owners, and complete teardown. It
is a conformance model, not evidence that an arbitrary adapter is safe to run.
The production authored iframe lifecycle retains its existing generation and
buffer tests and browser smoke coverage. The shared workbench retains at most two
workspace canvases in stable DOM order. Tab/owner switches and collapsed columns
make hidden surfaces inert and inactive. Stable directory IDs preserve rename
identity; a replacement clears old selection and runtime foundations. Git
conflicts are read before manifest parsing and pause the live canvas.

## Host decisions

| Work                            | Accepted host                                                          | Restrictions                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authored frame/text editing     | Existing sandboxed iframe runtime                                      | Keep bounded live frames, exact generation messages and active-only work.                                                                                                                         |
| Desktop authored evidence       | On-demand hidden Electron capture window                               | Private nonpersistent session, sandbox/context isolation, no Node, denied permissions/downloads/network, sanitized source and CSP preventing authored scripts. Destroy the window after each job. |
| Cloud authored evidence         | Disposable Chromium worker under dedicated UID 10002                   | Chromium sandbox required. No provider or capture credentials in the worker environment. One admitted capture per engine; retire the process group on cancellation.                               |
| Future live browser surface     | Separately owned native session/view, subject to product qualification | A DOM iframe shares its owning session. Native rectangles need explicit overlay/focus handling and cannot promise arbitrary CSS transforms or web parity.                                         |
| Future general executable tools | Independently stoppable worker/process                                 | A responsive host timer is not an OS CPU/GPU quota. DOM/WebGL workloads need their own host qualification.                                                                                        |

The Mac experiment confirmed storage partition separation, rectangle updates,
visibility, DOM focus, and hung-renderer retirement. **A fully hidden
`WebContentsView` did not reliably capture.** Use the dedicated authored capture
window for current evidence. Future live web surfaces need a poster/focused-view
fallback; they cannot borrow an authenticated app/browser session implicitly.
[Electron session model](https://www.electronjs.org/docs/latest/api/session),
[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view),
[capturePage](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts).

The Linux image installs the browser revision matching pinned Playwright Core.
The coordinator starts capture only in its attested cloud execution posture and
after a sandboxed render canary. Missing/failed capture leaves source tools
available and omits PNG capture from discovery. Playwright defaults sandboxing
off, so the worker explicitly enables it.
[Playwright launch options](https://playwright.dev/docs/api/class-browsertype#browser-type-launch).

## Measurement and regression envelope

Reference fixtures: default two-frame/48-layer editor at 1440 × 900; existing
10,000-layer interaction smoke; proposal capture at 320 × 240 and review at
1024 × 768; maximum API capture 2048 × 2048, DPR 1.

Reference hosts: Linux x64 VM, seven available vCPUs, approximately 16.25 GiB
RAM, Chromium 147; Mac16,13 arm64, 16 GiB RAM, Electron 43.2 / Chromium 150.
The full evidence and limitations are in the [qualification report](design-phase-0-1-report.md).

For the default closed-review fixture, investigate any recurring script/layout
work, growth across idle windows, median task time above 2 ms per three-second
window, or post-GC heap growth above 1 MiB from the recorded pre-review fixture.
These are initial regression thresholds for that fixture, not universal device
budgets. Captures must leave zero owned windows/worker processes after teardown;
resource saturation must reject before allocating another source bundle/browser.

Record engine/renderer CPU separately, main/guest RSS, GPU process metrics,
decoded media bytes, outgoing/incoming buffers, and remote execution cost.
The native probe measures a 60-second closed state. Its main-process CPU and
process memory snapshots do not certify OS energy impact or GPU allocation.
No additional surface kind is qualified by these Phase 0 measurements.
