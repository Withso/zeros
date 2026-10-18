# Design affine relocation and failed-write recovery

Canvas movement mixed screen deltas, world bounds and local CSS lengths; subtree extraction also lost inherited appearance, while a failed second file write could leave the first file changed.

Keep the world grab anchor, invert the complete parent affine map, and retain margins in bounded geometry snapshots. Admit only source contexts the relocation planner can preserve, recheck stylesheet identity at commit, and persist an inverse recovery journal before rolling back a failed multi-file edit.

Encoded in the protocol layout-geometry/relocation suites, renderer movement/drop tests, and engine relocation/relocation-geometry suites. The browser-backed extraction regression compares all four corners, not only an axis-aligned rectangle; the disk-failure regression reads the original source before any recovery-capable read.

The first renderer check is not commit authority: a stylesheet can change while journal preparation awaits I/O. Carry measured identity into the existing Foundation repository commit and validate it again immediately before journal admission. The relocation suite holds that boundary and asserts no authored bytes change. Preflight both escaped forward and inverse lifecycle journals before even updating `.gitignore`; retain the existing journal, history and snapshot bounds.

Canonical references are not a mutation list. Consume the shared ancestry projection, keep explicitly selected descendants, and refuse cross-scene movement rather than applying independent partial writes. Real-pointer fixtures cover a free affine child's release, different reflected/scaled parents in one transaction, current-camera scene movement, and world-space 1/8 nudges.

Keep an authored free layer distinct from a flow child temporarily dragged out of its layout. The native `--zeros-layout-origin-flow` inline hint preserves flow reentry; read only the node's own hint and never capture it as inherited appearance. Existing flow/guide-cancellation smoke and runtime context tests guard this compatibility seam.

A finished keyboard gesture owns its captured targets while Foundation loads; a later selection must not discard that completed edit. Validate membership when the key is released, while retaining page, lifetime, theme, runtime and measured-source fences through admission. Held gestures and queued follow-ups still retire on selection changes. The existing cold-Foundation smoke proves the original pair commits once after selecting a different layer.

Consecutive scene drags may begin from a local preview whose save has not acknowledged. Chain only that known predecessor's receipt, not an arbitrary newer source, and use its confirmed source and geometry for the next guarded write. An independent scene move must not ask a retiring HTML runtime for relocation measurements when no receiving frame exists. A held-acknowledgement browser regression checks both the second move and its cancellation; the full layout-gesture smoke retains its back-to-back position assertion.
