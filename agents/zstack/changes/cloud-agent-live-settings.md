# Cloud effort/Fast delivery and independent model admission

Symptom: the renderer marked mid-chat Claude and Cursor settings as applied,
but the cloud worker rejected the courier and both drivers kept their opening
selection. Cloud Claude also omitted Fast at creation. Separately, GPT-6.1
Terra passed root catalog verification but failed hosted control-plane parity.

Cause: renderer live-config support was provider-wide, while cloud routing was
Codex-only. Cursor sent bare native model IDs and never resolved effort/Fast.
The independently deployed control plane maintains a separate consent catalog
outside the root model gate.
The separate model-selection request can also acknowledge after a newer full
configuration, clearing its effort both in durable metadata and the live query.

Rule: trace a complete composer snapshot through exact-execution routing,
durable selection and actual native application for every provider/placement.
Ordinary Claude flags apply live, with explicit reset values; Max transitions
wait for the next prompt and preserve resume. Cursor captures one selection per
run and resolves native defaults, parameters, aliases and advertised suffixes
from its own account catalog. Never infer native parameters from display
capabilities. Every curated identity addition also verifies the standalone
control-plane catalog, all-model admission and unchanged explicit grants.
Fence model-only acknowledgements by configuration revision, before resetting
flags or persisting a selection, so they cannot undo a newer complete snapshot.

Encoding: worker routing covers all three agents and reopen persistence. Claude
and Cursor settings, native fixture, relay and Local parity tests cover live
application, next-send propagation, clears, delayed controls and query/run
ownership. `agent-models.test.ts` covers Terra consent and exact catalog parity.
The bug-fix playbook requires the producer-to-native trace; the runtime upgrade
guide names the independent admission catalog. Eval cases
`cloud-agent-live-settings` and `codex-terra-control-plane-consent` retain these
checks. The harness capability guide owns one provider/placement timing table.
