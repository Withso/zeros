# Incomplete restored history is unknown

Symptom: a resumed cloud chat displayed the empty-chat placeholder even though
the provider still retained the conversation. An empty attach snapshot also
erased a previously painted transcript.

Cause: empty message arrays lost their incomplete restore-head meaning, and
session admission rebuilt the slot without its provisional presentation marker.

Rule: a missing or incomplete current restore head cannot confirm an empty
transcript. Keep eligible exact-owner presentation and its marker through
admission, and show catching-up state until history becomes authoritative.
Positive current native rows remain usable while completeness stays unknown;
native residency never confirms an incomplete FULL head or promotes an older
manifest. Keep the catching-up state visible beside long resident history,
and suppress empty-chat affordances until coverage is confirmed. An empty
native read may not establish completeness. New edit, prune, delete and owner
fences still apply.

Retain a positive native read through a later empty read under the same
incomplete authority. Track the confirmed native owner/head and receipt, then
recheck exact chat, execution, head and access before preserving it. Equal
heads or an already resident slot alone do not prove native confirmation:
the first native read must still invalidate an older CP presentation. Local
queued/streamed array changes cannot discard native confirmation. Retire the
bounded receipt records with eviction, reset, head invalidation and disposal.
Recheck freshness before applying an incomplete read's destructive branch:
a same-head empty reply loses to newer native state, including a turn that
starts and settles before the reply arrives. Keep ready-state waiters attached
to the fresh revalidation; a streaming successor remains canonical.

Encoded in the hydrate, cloud-snapshot, history-head and transcript-bind tests,
plus the actual AgentChat resume browser scenario across cloud, Local and
organization-local owners. Never recover an older manifest in the renderer.
