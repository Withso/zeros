# Keep PR presentation separate from checkout authority

A new HEAD invalidates write authority and in-flight reads, but the last
confirmed snapshot for the same repository and branch can still paint while
revalidation runs. Retire presentation when its branch, base or connection
changes. Discovery of no PR needs the same exact-key treatment as a found PR.

Worker ref hints must follow the control plane's checkout acknowledgement.
Retain a failed hint for retry and coalesce it with the existing filesystem
observation. An acknowledged ref hint can bypass a healthy GitHub observation
window; ordinary file events keep their cadence and errors keep their backoff.
Publish native Git state and each confirmed Review resource independently so
slow checks or authentication preflights cannot hold unrelated presentation.
Partial publication must not mark the entire refresh complete: a remount needs
to join any unfinished Git or GitHub read while keeping the confirmed row.

These rules are covered by checkout-notifications, cloud-pr-presentation,
workspace-pr-activity, cloud-pr-status-reads and review-first-result tests.
