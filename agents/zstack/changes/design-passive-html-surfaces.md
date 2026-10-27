# Passive HTML surface qualification

- Symptom: browser fixtures loaded source surfaces, but the native app never
  prepared its frames. Cause: a new reply field was rejected by the real strict
  wire decoder, which the browser harness bypassed. Rule: exercise the actual
  request and reply schemas before trusting a transport substitute. The Local
  source-surface capability, legacy reply-shape tests, and preparation bridge
  regressions encode negotiated compatibility; cloud keeps Design unavailable.
- Symptom: a loaded page unnecessarily started editing runtimes and captures
  during passive source preparation. Cause: unprepared descriptors entered the
  live set and were later protected as already-painted editors. The residency
  regression distinguishes metadata demand from mounted document ownership.
- Symptom: contended native navigation switched supported frames back to
  pictures. Cause: the script handshake's deadline began at iframe mount,
  before the protocol response arrived. The delayed-navigation browser
  regression keeps responsive outgoing HTML painted through a held response;
  navigation and loaded-document deadlines are separately bounded.
- Symptom: native frames completed navigation but fell back to captures,
  despite passing ordinary browser readiness checks. Cause: a hidden child
  waited for animation callbacks before its parent made it visible. The
  browser regression disables child requestAnimationFrame completely; passive
  readiness settles assets, forces layout, and acknowledges without that clock.
- The same native trace exposed image resources that had loaded with correct
  natural dimensions while `image.decode()` remained pending in hidden
  cross-process frames. Resource readiness and paint readiness differ. The
  retained browser regression suspends both animation and decode callbacks,
  includes a real PNG, and verifies eager loading plus synchronous first-paint
  decoding. Native coverage must still prove the result on the real protocol.
- Symptom: activating an editor changed transparent pixels. Cause: inherited
  color-scheme flattened the passive iframe, the editor added an opaque app
  background, and two translucent documents could paint together. The pixel
  regression uses a colored parent (white hid the bug) and exercises passive
  → editor → passive. Keep incoming documents hidden and paint one ready
  document, with no implicit app background.
- Symptom: a one-pixel keyboard edit vanished after a runtime reload. The
  gesture correctly rejected a changed runtime revision, but the revision
  came from a delayed MutationObserver publication of initial HTML parsing.
  Observe only after DOMContentLoaded. The protocol regression inserts the
  runtime in the head, proves a quiet initial revision, then proves a real
  later mutation still publishes; evaluating the runtime after constructing
  the test DOM had missed the production initialization order.
- Symptom: cached pictures covered responsive outgoing HTML during a source
  replacement. Rule: keep painted-source ownership separate from exact incoming
  generation readiness, and charge both generations until the old DOM detaches.
  Browser handoff checks and source-budget overlap tests enforce both contracts.
- Symptom: authored important layers kept passive animations running, and
  encoded image separators hid allocation costs. The real-browser animation
  regression and source-cost tests cover cascade order, inline motion, HTML
  entities, CSS escapes, and unknown imported assets. Unknown costs fall back
  rather than entering an uncharged passive document.
- The raster fallback also needs real display ownership: recreating an image
  from a decoded URL can still miss a paint. Reuse its loaded element through
  culling and preserve it below an activating editor; hide it atomically once
  the editor is ready. The 256-frame browser regression counts every visible
  frame through actual wheel zooms and return pans.
- Do not treat a cache miss as memory pressure. A missing preview was clearing
  unrelated warm decoders, and optional detail could evict small return-pan
  covers. Regressions distinguish missing data from capacity, try admitted
  coarse pixels before reclaiming peers, and retain small covers ahead of warm
  detail without raising either memory budget. Explicit captures still reclaim
  optional warm state.
- Real-shell printf tests must disable startup files explicitly. Bash may read
  an rc file in a remote session without interactive/login flags. The unchanged
  output contract failed on both qualification hosts until the test's Bash
  invocation added `--noprofile --norc`; the production login-shell probe keeps
  its normal startup behavior.
- A source-identical qualification projection must include bundled runtime
  catalogs, not only application files. The native comparison's isolated
  renderer failed to boot because its input manifest omitted the statically
  imported model catalog. The manifest regression covers both bundled catalogs
  and proves their changes invalidate the digest before any measurements run.
- A native performance report containing both builds and per-process samples
  exceeded the lock marker's 256 KiB reader limit. Keep lock/status metadata
  small, but read measured reports through a separate bounded 4 MiB regular-file
  reader. The regressions cover the real report size, the upper bound, symlink
  rejection, and the unchanged marker cap.
- An HTML-only canvas has no raster demand, but it still owns cache maintenance.
  Treating an empty picture list as an inactive canvas skipped the one-time
  metadata read, leaving 60 MiB of injected restart debris above the 48 MiB disk
  budget. Active empty demand now prunes metadata without reading blobs,
  allocating image URLs, or capturing. Personal and organization-local tests
  also prove hidden canvases remain inert and returns share that index read.
- Native restart drivers must wait for exact-key workspace confirmation, not
  only engine connection or provisional rows in the visible union. Boot
  discovery can supersede an explicit refresh before its caller resumes.
  The driver starts reconciliation once, polls only the confirmed exact-key
  snapshot, then navigates once. Delayed project/row publication and wrong-ID
  regressions preserve saved fixtures instead of silently adopting replacements.
- A fresh profile hid a restored-frame regression: structural sharing compared
  source versions but ignored newly confirmed surface costs. Boot frames kept
  their cost-free objects and never entered passive HTML admission. Compare
  every admission field, including its removal, while reusing equal objects.
  The boot-snapshot regression and 256-frame browser smoke now pass confirmed
  preparation through production sharing; native acceptance also reuses the
  preserved playground profile and requires actual passive documents, not just
  picture coverage. Do not wipe old state to qualify an upgrade.
