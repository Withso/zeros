# Cloud access during provider outages

Symptom: a GitHub outage or secondary rate limit could close live workspace
connections and suppress the activity that prevents idle stop.

Cause: fresh admission and continuation shared a short permission lease, and
the relay's transport heartbeat performed authority/database work. HTTP 403
was treated as a denial even for GitHub secondary limits. An uncertain token
rotation could later be misreported as an expired authorization.

Rule: separate new admission from an existing verified session. Retain only
exact-generation, immutable-source evidence for a bounded period anchored at
the original successful check. Refresh on activity, coalesce replicas, honor
provider backoff and keep transport pings free of database work. Record current
worker activity independently. Confirmed denials invalidate cached and in-flight
results; a timeout is not a denial. Do not replay an uncertain rotating token.

Encoded in control-plane source-availability, verification-store integration,
relay, continuation-routes, worker-routes, store integration, token-rotation and
GitHub availability tests. Output stays synchronous while authority is current;
only a due check uses a bounded queue. Test a normal burst, held authority,
session expiry, cancellation races and configuration changes during grace.
Healthy permission refreshes must still discover repository transfers. Reuse
their immutable-ID responses, share the canonical result across replicas and
order binding updates by observation time. An outage fallback cannot freeze
the old name indefinitely or let a delayed success undo a newer rename.

Composition fixtures that isolate provider-login propagation must establish
both admission and continuation authority. Run login-refresh integration tests
with the source and relay suites; retain real notification, disconnect, owner
scope and replacement assertions when updating that isolated boundary.
