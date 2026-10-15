# Keep unavailable history distinct from ongoing work

Symptom: a readable cloud chat permanently showed a catching-up spinner, and a
new empty chat showed loading while its first history read was held.
Cause: the UI treated incomplete FULL history coverage as active work and every
non-resident slot as known old history. Coverage, residency and work are separate.
Rule: retain readable exact-owner rows without a coverage spinner. For empty
UNKNOWN history, offer a quiet read-only retry without claiming no messages.
Only known old history gets a brief cold-load indicator; after its bounded
presentation window, keep a static unavailable state without changing the read,
transcript authority or retry policy. Retained surfaces keep the elapsed deadline
but retire timers while the tab or window is hidden.
Encoded by: scripts/ui-smoke-transcript-resume.mjs and the production AgentChat
hook, with both Local owners, cloud, held reads, positive native rows and window
hide/reveal. The companion cache-paint fixture seeds hasTranscript explicitly:
patchSession derives that flag from message arrays, so an empty mutation cannot
establish known history. Fake-clock handoffs use browser time, not host time.
Proposed target: playbooks/bug-fix.md, renderer history presentation guidance.
