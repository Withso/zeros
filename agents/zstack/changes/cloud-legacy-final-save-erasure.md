Provider-verified deletion stayed in waiting_for_provider after the final-save
expansion. The current Delete was proven, but the new eligibility predicate
required recovery rows for earlier successful Stops before any worker could
encounter and adopt those rows. Migration tests manually called the adoption
helper, bypassing the production scheduler/claim boundary.

Drive both real consumers after migrating existing rows: a due read must expose
finite adoption work, and the operations worker must complete the original job.
Use a later engine incarnation in the fixture; an older receipt must remain
ineligible for current provider dispatch. Resolve only historical erasure
custody behind a proven later Delete and positive provider retirement, keeping
the original identity and receipt. Refused proof retains durable retry ownership
and must not create a hot operations loop. Bound batch size and lock parents
before the job; no live provider call or second lifecycle action belongs here.

The retained real-PostgreSQL migration/worker controls and the
cloud-legacy-final-save-erasure eval encode the escape. Run under capability
sets zero and no-new-privileges. Initial fixture failures are not assertion
reds: a sealed source cannot upload again, and dispatch settlement needs a
provider observation at or after admission.
