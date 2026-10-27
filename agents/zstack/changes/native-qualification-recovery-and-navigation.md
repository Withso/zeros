# Native qualification recovery and navigation

- Symptom: a native command timed out after one successful Mac readback.
  Cause: result transport did not establish whether the command executed.
  Rule: recover the existing run marker, process status and a fresh report
  before any relaunch; retain the original request and failure. Encoded in
  `zstack-verify` evidence rules and `design-native-run.test.ts`: live/unknown
  ownership, stale report rejection, exclusive legacy launch fencing and
  preservation of abandoned markers.
- Symptom: the native driver tried to leave Design using `files` as a tab ID
  and opened Design by adding a tab. Cause: workbench IDs are generated per
  workspace, and adding an existing ID does not activate it. A runtime probe
  of `defaultTabs()` reproduced the missing assumed ID. Rule: resolve the
  existing tab by type, activate its actual ID and verify the destination.
  Encoded in `zstack-verify`, `design-native-workbench.test.ts` and the synced
  terminal runner. Local launcher tests do not establish native lifecycle
  qualification.
- Symptom: qualification depended on ignored task-local drivers while remote
  command transport timed out. Rule: an operator
  handoff uses a regular source entry point, with an exact-source guard,
  separate build/profile outputs, bounded process ownership and resumable
  status. Encoded in `scripts/design-native-run.mjs` and documented in the
  Design roadmap; no native pass is inferred from preparing the launcher.
- Symptom: the native product driver reached worktree adoption before its
  bridge existed, although its readiness wait had returned. Cause: the pinned
  Playwright `waitForFunction` accepts a Promise as truthy and returns its
  eventual false value without polling again. Rule: poll awaited `page.evaluate`
  results for asynchronous readiness; never put mutations in a retried probe.
  Encoded in `scripts/design-native-renderer.mjs` and a real Chromium regression
  covering delayed readiness and readiness that never arrives. Both assertions
  fail with the prior wait and pass with the awaited polling helper.
- Symptom: native fixture counts appeared comparable while larger grids added
  visible rows and the canvas pane changed size. Rule: hold authored visible
  complexity, camera, pane dimensions and panel state constant, place extra
  descriptors beyond overscan, and sample after natural settling. Keep complex
  and all-visible workloads separate. Encoded in the fixed-view fixture
  regression and `design-native-performance.mjs`; capture observations are
  sampled values, not guaranteed transient peaks.
- Symptom: the native source guard omitted root build files and resources.
  Rule: bind evidence to those inputs too, and refuse implicit Git discovery
  inside an ignored projection. The manifest regression changes `index.html`,
  root build configuration and a native resource; each must change the digest.
  Reconstruct historical sources in an isolated checkout, verify their full
  manifest, and give workspace packages independent source links even when
  sharing installed third-party dependencies.
- Symptom: an isolated native benchmark never started Vite because an imported
  configuration lost `__dirname`. Cause: Vite externalizes a `file:` import,
  bypassing its config transformation. Rule: preserve the original configuration's
  bundling and directory when isolating its cache. Encoded in
  `design-native-vite.test.ts`, which loads the actual production configuration;
  it fails with the external URL and passes with the filesystem import.
- Symptom: the standalone engine appeared in native memory samples with no CPU
  time. Cause: Chromium does not account for the separate engine process. Rule:
  read its OS cumulative CPU time, keep unavailable readings missing, and
  rediscover its PID after each app restart. Encoded in the real-process and
  CPU-format regressions in `design-native-baseline.test.ts`; reports name the
  accounting source and do not sum RSS as private memory.
- Symptom: a cold native navigation reset the benchmark camera before its
  document-ready wait, leaving a distant scene at automatic-fit zoom. Rule:
  wait for the exact directory/page publication, then apply the controlled view
  once; retry only observations. An overview may become ready through pictures
  without a live document. The browser regression in `design-native-view.test.ts`
  holds cold publication until the driver observes it and reproduces the lost
  camera with the prior order.
- Symptom: qualification cleanup raised EPERM after the worker exited; later
  process recovery found no remaining group. Rule: a denied signal counts as
  retired only after an independent process-table probe confirms there are no
  live members. Live and unknown groups remain errors. Encoded in
  `electron-local-process-group.test.ts`; the recovered absence does not prove
  which kernel state existed at the instant of the original signal.
- Symptom: all retained organization-local records referenced missing folders,
  and account-free Local development intentionally pins Personal. Rule: use
  fresh authored fixtures and retained database rows in a task-owned profile.
  Ordinary Dev authorization must confirm membership before native owner tests.
  A custom ZEROS_DATA_DIR also redirects the channel-primary account path, so
  use a fresh Dev instance slug with normal shared sign-in instead; never copy
  credentials or fake membership. The fixture CLI tests exercise creation,
  isolation, authored reads and refusal of existing destinations.
- Symptom: the isolated ordinary Dev app could not decrypt its shared session,
  then timed out waiting for the gated bridge. Cause: Playwright's default
  Electron loader injects a mock Keychain and disables background scheduling.
  Rule: native authorization and idle measurements use the installed Electron
  executable explicitly, preserving its native defaults. Read normal sign-in
  and membership before waiting for BridgeProvider, which AuthGate owns. The
  real Electron launch regression and browser authorization-order regression
  both fail under the old driver and pass with these changes. Fixture manifests
  copied between machines must be regenerated on the target; copied absolute
  paths do not prove that native checkout directories exist.
- Symptom: full-suite engine startup fixtures failed at shutdown after the
  new preview-retirement hook was added. The fixture used Object.create and
  omitted the constructed workspace service. Rule: a lifecycle test double
  must include and assert newly owned cleanup services. The startup suite now
  verifies preview retirement on shutdown; the original four failures and
  the corrected startup/preview/workspace runs are retained in the receipt.
  The full run also exposed partial-service doubles that hid new Git exports
  and a smoke fixture that returned a boolean for document accounting. Preserve
  unmodified exports in narrow mocks and represent the held native buffer in
  synchronization fixtures; all five affected suites pass on the recorded rerun.
- Symptom: native owner captures had the correct viewport and text but lost the
  background below short body content. Cause: SVG foreignObject does not carry
  HTML's body-to-canvas background propagation, and clearing the cloned body
  can also break inherited child and pseudo-element colors. Rule: inspect
  decoded pixels outside the content box, including transparency; dimensions
  alone do not prove fidelity. Encoded in the owner driver's PNG assertions
  and `design-runtime-canvas-background.test.ts`, comparing against real
  browser pixels with opaque, translucent, root, containment and important
  cascade-layer cases. Snapshot overrides belong only to the cloned document.
- Symptom: owner switching eventually quarantined capture even though its
  hidden native window had been destroyed. Cause: Electron can leave a pending
  `executeJavaScript` promise unresolved after WebContents destruction, so the
  host never reached its cleanup acknowledgement. Rule: join the positive
  native destruction event at each asynchronous render step; cancellation
  intent alone must not release admission. Encoded in the real Electron
  `design-capture-retirement.test.ts`: hold page readiness, cancel the identified
  job, verify zero windows and a terminal acknowledgement, then capture again.
  The regression fails before the fix and passes on macOS. Headless Linux
  process launch alone cannot qualify native BrowserWindow lifetime.
- Symptom: the native process sampler failed during its first fixed-view
  workload while the application itself remained readable. Cause: CDP target
  enumeration included a disposable native capture page that retired before
  its locator query. Rule: skip only positively closed pages during discovery;
  preserve errors from a live page and still require exactly one visible
  fixture. Deterministic discovery regressions fail before the correction and
  pass afterward. Native capture test doubles must also emit the real
  WebContents destruction event used by the host cleanup contract.
- Symptom: the full pack gate rejected two new eval drafts with a pending
  fix identity. Rule: keep drafts outside the published eval registry until a
  real full commit SHA or PR number exists; never invent an identity or weaken
  the registry validator. Retain the regression tests and learning fragment
  immediately, then publish the eval definitions with their verified fix.
- Symptom: an asynchronous workspace dispatch returned Playwright's generic
  execution-context error after the destination was already displayed, without
  an app reload or engine restart in the logs. Chromium can collect a promise
  held only by CDP's awaitPromise; the real-browser regression reproduces that
  same error while the document's time origin remains unchanged. Rule: start
  a qualification mutation once, retain its promise and terminal record in the
  original document, and poll only its acknowledgement with a bounded deadline.
  A replaced document or explicit action error still fails; never replay the
  mutation. The native incident's precise protocol cause remains unrecorded.
  Use attached-state waits for empty marker elements in tests; their lack of
  visual size must not be mistaken for an action timeout.
- Symptom: a fixed-view run failed after its native window widened from 1440
  to 1648 CSS pixels. PNG dimensions confirmed a whole-window resize, with no
  renderer navigation. Rule: lock only the isolated benchmark window's planned
  dimensions, retain the size assertion, and report expected/observed geometry
  on failure. Do not accept samples at different view sizes or change the
  operator's regular development window.
- Symptom: overview frames disappeared while their encoded replacements were
  already cached. Cause: canvas admission used encoded availability before the
  display decoder had committed a cover. Rule: retire a live document only
  against an owned decoded display; retain the old lease through DOM replacement.
  The browser regression holds the actual preview decoder across a camera
  change, and the unit regression checks owner/generation and idempotent release.
- Symptom: a browser test inspected an empty cache while the app was visibly
  using previews. Cause: a direct module import after Vite hot reload observed
  another singleton instance. Rule: inspect the exact stores exposed by the
  rendered fixture. The Design harness now exposes its real preview store;
  guest-frame decoders stay independent of the held host-display decoder.
- Symptom: native text PNGs had correct dimensions but opaque backgrounds.
  Cause: the capture window's default backing canvas flattened authored alpha.
  Rule: check decoded transparent/translucent pixels and root/body precedence,
  not only dimensions or text. The real Electron pixel suite covers both themes,
  native viewport and scaled output. Version disposable caches when pixel
  production changes, and test restart rejection of old pixels.
- Symptom: transparent text frames beyond the live-runtime cap stayed blank.
  Cause: both demand and display excluded text. Rule: cover every supported
  frame kind with a bounded pixel path. A 256-text-frame budget test and a real
  browser fixture with more text frames than live slots cover the shared path.
- Symptom: an overview run lost coverage after physical input changed its zoom.
  Cause: only its initial durable camera was checked. Rule: record the painted
  transform, owner and viewport at sampling boundaries; refuse a disturbed
  camera even before the durable store catches up. Only the isolated native
  benchmark window ignores physical mouse input. A browser regression changes
  the transform independently of the store and preserves the refusal.
- Symptom: a warm zoom-out lost visible pixels for several animation frames
  even though all 256 frames had already been captured. Cause: the imperative
  camera painted before deferred React admission and a new display decode.
  Rule: count source rectangles intersecting the painted camera, not only
  mounted DOM; test every animation frame during warm pan and zoom. Commit
  changed membership before paint and reuse bounded, charged decoded previews.
  Encode cancellation, pressure eviction, owner isolation and hidden cleanup
  in decoder tests; do not preserve continuity by mounting distant documents.
- Symptom: a sharp-zoom PNG had the right size but lost an authored SVG shape.
  Cause: authored SVG rules also repositioned the temporary capture container.
  Rule: isolate transport geometry from author selectors without freezing all
  computed root styles, which breaks inherited currentColor. Browser pixel
  tests cover CSS/SVG edges, root rem/color, important foreignObject rules and
  translucent pseudo-elements. Compare fractional CSS boxes with actual
  Chromium paint: its normal pixel snapping is not evidence of a bitmap zoom.
- Symptom: a pan regression reported missing pixels on frames whose runtime
  screenshots were visible. Rule: count every supported painted surface and
  retain source-rectangle coverage checks; a missing test marker is not a
  rendering failure. The browser and native coverage probes now include runtime
  screenshots, alongside decoded saved pictures and ready displayed documents.
- Symptom: panning reprioritized a still-visible live document before it had a
  decoded cover, and unused full-size screenshot reservations evicted warm
  overview previews. Rule: keep uncovered visible live frames within the live
  cap, and reserve only pictures the surface can actually paint. The residency
  regression and 256-frame warm pan/zoom smoke preserve both failure cases.
- Symptom: one sharp Retina crop used nearly the entire image budget, leaving
  its next crop permanently unadmitted after a pan. Rule: budget an explicit,
  application-wide replacement overlap and keep both outcomes bounded. Only an
  exclusive live lease can authorize it; another consumer cannot pin either
  image until commit/cancellation. Unit regressions cover foreign/released/shared
  leases, cancellation and competing frames. Browser smoke keeps sharp pixels
  through repeated Retina pans and verifies zero image leases when hidden.
