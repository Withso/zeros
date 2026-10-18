# Design affine relocation and failed-write recovery

Canvas movement mixed screen deltas, world bounds and local CSS lengths; subtree extraction also lost inherited appearance, while a failed second file write could leave the first file changed.

Keep the world grab anchor, invert the complete parent affine map, and retain margins in bounded geometry snapshots. Admit only source contexts the relocation planner can preserve, recheck stylesheet identity at commit, and persist an inverse recovery journal before rolling back a failed multi-file edit.

Encoded in the protocol layout-geometry/relocation suites, renderer movement/drop tests, and engine relocation/relocation-geometry suites. The browser-backed extraction regression compares all four corners, not only an axis-aligned rectangle; the disk-failure regression reads the original source before any recovery-capable read.
