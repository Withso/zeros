# Qualification covers the assignable rollout

Symptom: approving a newer candidate base caused automatic qualification to
ignore the older rollout default. Organizations still assigned to that default
could not receive newly published runtime fixes.

The admission target set must reach every producer that makes a release usable.
Trace configuration through the production worker factory, publication enqueue
and background discovery. Registration order is not a substitute for the
configured default and candidate. Retain the bounded newest-two release window
before filtering terminal history, independently for each target compatibility.
A failed newest release blocks fallback on that compatibility only.

Newly queued work stores its base image and compatibility before provider I/O.
Claim validates that original choice instead of selecting a newer base. A
removed or revoked target refuses; legacy unpinned rows bind once. Qualification
evidence still belongs to a compatibility and does not change organization base
assignment or an existing workspace generation.

The real PostgreSQL regression seeds 151 releases, two assignable bases and a
newer unassigned base. It requires exactly four successful automatic runs,
per-base failure isolation, config-to-worker wiring, queued identity and
concurrent enqueue controls. The seeded eval drops only the factory's rollout
argument; the regression must catch the resulting default-base omission.

A diagnostic that depended on a treatment being qualified only on the candidate
must establish separate runtime isolation before publication after this change.
