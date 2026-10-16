# Jump directly to the selected loaded message

Symptom: choosing a distant message in the navigator visibly traversed history
before reaching the destination.

Cause: the checkpoint rail deliberately hopped to one viewport before a far
message, then used a smooth scroll for the final movement and first correction.

Rule: an explicit navigator selection is an immediate jump. Make the target
reachable, pin its stable message ID, and correct estimated layout without
animation. Keep existing cancellation on user input, replaced navigation and
bounded settling. Do not infer missing geometry means a loaded target; fetching
unloaded history belongs to the exact-key windowed page-store path.

The retained callback regression asserts immediate destination, no intermediate
scroll writes, pin/spacer behavior, correction and cancellation. The real
AgentChat browser scenario verifies native scroll calls and the destination for
Personal Local, organization-local and cloud, covering both rail and popup
selection. Isolate placement cases under the paused browser clock so a prior
case's open hover portal cannot intercept the next case's pointer target; retain
that interaction failure separately from the navigation assertion red.
