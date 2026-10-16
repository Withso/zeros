## Diagnose the owning dependency graph before cleanup

A root install did not hydrate the independent control-plane dependency graph.
The Dev R2 adapter resolved its SDK there, while GC replaced the loader failure
with a generic cleanup message. The inventory could not even be reviewed.

Shared adapter preflight now emits a closed missing or unavailable dependency
code and the exact control-plane install command. PostgreSQL resolves its driver
before local filesystem or process work. Concrete adapter regressions inject
missing and broken modules containing private text and prove that text is absent
from the diagnostic. A scratch failure still closes the registry client.

The owner's retirement boundary is implemented in the GC CLI: Mac-only apply,
fresh plan echo, exact reviewed plan digest, and a keyed resource-set recheck
under the existing lease. Ineligible active owners and unreceipted quarantine
are never selected. The retained tests cover changed targets, eligibility and
quarantine; none calls a live provider.

Proposed guidance for the next playbook fold: trace the dependency resolver's
package root when a maintenance command fails before its first provider call.
Test the concrete adapter and the public closed diagnostic, not only a mocked
maintenance operation. Keep cleanup approval bound to the observed resource set.
The replay targets the pre-existing concrete adapter; the new diagnostic helper
loads only in its own test. Its absence on the parent must not replace the
missing-dependency assertion with an import failure.
