# Design affine relocation and failed-write recovery

Canvas movement mixed screen deltas, world bounds and local CSS lengths; subtree extraction also lost inherited appearance, while a failed second file write could leave the first file changed.

Keep the world grab anchor, invert the complete parent affine map, and retain margins in bounded geometry snapshots. Admit only source contexts the relocation planner can preserve, recheck stylesheet identity at commit, and persist an inverse recovery journal before rolling back a failed multi-file edit.

Encoded in the protocol layout-geometry/relocation suites, renderer movement/drop tests, and engine relocation/relocation-geometry suites. The browser-backed extraction regression compares all four corners, not only an axis-aligned rectangle; the disk-failure regression reads the original source before any recovery-capable read.

The first renderer check is not commit authority: a stylesheet can change while journal preparation awaits I/O. Carry measured identity into the existing Foundation repository commit and validate it again immediately before journal admission. The relocation suite holds that boundary and asserts no authored bytes change. Preflight both escaped forward and inverse lifecycle journals before even updating `.gitignore`; retain the existing journal, history and snapshot bounds.

Canonical references are not a mutation list. Consume the shared ancestry projection, keep explicitly selected descendants, and refuse cross-scene movement rather than applying independent partial writes. Real-pointer fixtures cover a free affine child's release, different reflected/scaled parents in one transaction, current-camera scene movement, and world-space 1/8 nudges.
