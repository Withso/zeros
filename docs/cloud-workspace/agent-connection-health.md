# Selected cloud agent accounts

Organization cloud-account Settings distinguish a stored credential from the
source currently selected for a provider. A fresh, unselected import cannot make
an expired selected account connected. Local Personal and organization-local
provider credentials and launches keep their existing engine paths.

## Health observation

The existing `GET /v1/organizations/:organization/agent-connections` response
adds an optional, strict version 1 `connections[].health` object. It describes
the exact selected credential revision, actual live revision, material version,
expiry and observation time. The provider, connection revision and credential
ID remain the connection identity. The separate vault `credentials[]` list
does not receive this field. Older control planes can omit health; consumers
must treat absence as unavailable observation.

The control plane joins the selected organization association, live credential,
material and Codex refresh metadata in one SQL snapshot. The observation adds
no provider request, decryption, refresh or write. The enclosing Settings GET
already performs legacy organization reconciliation and is not a read-only
route. Existing account, membership and organization-consent checks still run.

`status` is one of `ready`, `not_selected`, `consent_required`,
`credential_unavailable`, `credential_changed`, `expiring` or `expired`.
`connected` is true only for `ready`. Readiness requires the selected and live
credential revisions to agree and material to remain beyond the existing cold
admission floor: 60 seconds for Cursor API credentials and 30 seconds otherwise.
A non-expiring API credential retains its null expiry.

`refresh` is `not_applicable`, `idle`, `in_progress`, `reconnect_required` or
`unavailable`. Codex refresh metadata must match the exact credential revision,
material version and approved runtime. A reserved or dispatched attempt is in
progress only within its existing 15-second window; a future timestamp is not
evidence of progress. An uncertain or elapsed dispatched attempt requires
reconnect. Missing or mismatched metadata never promises automatic recovery.

Health is neither model admission nor a refresh grant. It does not extend
actor, material or provider authority, and a stored refresh token does not by
itself make an expired cold boot usable. Reconnect continues to use the explicit
fresh native authentication ceremony. After a conflict, retain any successful
import, read current revisions and require an explicit retry; never overwrite
the selection automatically. Key reads by signed-in account and organization
and fence late replies across owner switching.

## Expired selection publication

Selection publication first commits its durable native start fence in a
separate preflight transaction. A pending response must not roll that fence
back. The released selection API has no client operation ID, so the control
plane retains a private identity for the exact request and replays pending or
committed requests against their original operation.

An elapsed publication moves to cancellation, issues its existing release
controls and re-reads the durable row before deciding whether closure is
complete. Every boot that received the provider still needs its exact release
acknowledgement or positive retirement proof. Silence, an empty mirror or an
expired deadline is not retirement. Original operation IDs, deadlines, control
bodies and receipts are not renewed or replaced.

Connection publication can also include an initialized boot to enable a provider
it has never received. A permanently revoked exact engine cannot acknowledge
that control or receive a first delivery. This specific control no longer holds
publication when its original binding survives, its immutable source-delivery
journal has no delivery for that provider, and neither its initial adoption nor
its saved material contradicts that fact. The check runs under the owner lock
shared with first delivery. A missing binding, lease expiry alone, any historical
delivery, or a changed boot identity still requires positive closure. This is
not a retirement receipt: other providers, native acknowledgements, explicit key
replacement and destructive removal retain their existing rules and evidence.

The authorized organization Settings read progresses at most 16 elapsed
connection publications under that same owner lock, across providers. This
closes abandoned preparing/cancelling rows using their original release or
retirement evidence, including retained proof after a binding was deleted.
It never selects an account, creates a successor, contacts a provider or wakes a
workspace. Reads without expired publications add a bounded indexed lookup;
there is no background polling loop. Membership and consent checks still precede
closure, and an unproved boot remains pending.

A later authenticated selection can create a successor only after the elapsed
attempts for the same owner, organization and provider have closed. Each request
progresses at most 16 such attempts. If more remain, the closures commit and the
request returns the existing `cloud_agent_credential_busy` response. There is no
internal retry loop. A successor that expires during preflight also returns
pending; another explicit request is required. A committed lost-acknowledgement
replay stays a replay even when a later, different request is pending, and the
source-write transaction still checks the current selection and revision.

Explicit credential replacement IDs have different semantics: an expired or
cancelled operation returns `agent_credential_conflict`. The caller must start a
new request. Selection recovery must never silently revive those explicit IDs.

The regression suites exercise real PostgreSQL start fences, release
acknowledgements, positive retirement, bounded overlap and committed replay,
alongside exact-source health and immutable refresh metadata. Neither this
observation nor publication recovery changes ordinary launch authority or
grants longer detached agent lifetime.
