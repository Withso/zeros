# Separate queue pause from current-command cancellation

An exact Stop for a queued successor cancelled an earlier command during native
preparation. The runtime used their shared paused control as cancellation proof
after the earlier command already owned a claim.

Pause future claims separately from cancelling current admission. Retain an exact
command fence, or a legacy Stop fence on the unresolved claim identity, through
lost replies. Test queued-successor Stop at both preparation and dispatch, exact
and legacy cancellation, and explicit Resume of preserved follow-ups.

The unchanged independent SQLite regression, queue recovery controls and
`seeded-cloud-stop-admission-target` enforce this distinction. The bug-fix
playbook now names the cross-command preparation race.
