# Cloud prompt delivery has four distinct receipts

Symptom: a cloud Send depended on a live bridge, showed a queue card on a
running VM, or disappeared after refusal. App exit lost undispatched work; a
worker restart left an in-flight request and working indicator alive forever.

Cause: the desktop FIFO and execution were treated as delivery authority.
Putting future prompts directly into canonical transcript rows also lets the
current provider's next chunk attach beneath a later prompt. During rollout,
an empty new outbox does not prove that a legacy bridge turn has stopped.

Rule: distinguish a strict private-journal commit, the CP's committed receipt,
the VM's fsynced inbox ACK and actual provider acceptance. Repair uncertainty
with the original ID and bytes. Fence claims with chat epoch, current boot and
access; never blindly replay a provider handoff after restart. Project saved
bubbles beside native rows by exact IDs, and derive activity from the actual
turn. Retain the last confirmed snapshot while reopening private storage.
Do not import completed native history into the private retry quota ahead of
pending or refused work; preserve those receipts and their retry payloads.
Foreground Send must bypass its own slow status read within the shared request
bound. Keep legacy native Stop/close confirmation until a matching receipt owns
the turn. A capability flag needs a compatible runtime and refreshed workers,
not merely a CP configuration change.

Encoded in CP `prompt-outbox.integration.test.ts`, worker
`prompt-inbox.test.ts`, renderer `cloud-prompt-{channel,journal,coordinator,
presentation,runtime,handoff}.test.ts`, `cloud-stop-lifecycle.test.ts`,
and the seeded lost-response identity eval. The local profile regression keeps
rollout enabled only for `electron:cloud` by default, with an explicit override.
Local Personal and organization-local retain their existing send paths.
