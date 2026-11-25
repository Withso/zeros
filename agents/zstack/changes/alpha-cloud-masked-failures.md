# Alpha cloud failures: masked codes and slow-only request logs

Target: `playbooks/alpha-operator.md` (diagnosis).

- **Symptom.** On Alpha, connect and the `/github` route intermittently return
  503 `cloud_workspace_unavailable`, and the response says nothing more.
- **Cause.** `apps/control-plane/src/app.ts` rewrites every 5xx under
  `/v1/cloud-v2/` to that one code. Railway's request log records only slow
  requests (over 1 s). A fast 401 or 409 never appears, so a missing line
  does not prove a request didn't happen.
- **Rule.** Diagnose with Railway deployment logs, read-only through the
  project token's GraphQL `deploymentLogs` with a time window. Correlate the
  failure's timestamp with `[cloud-v2] timing` phases (`boat_create`,
  `protected_route`, `token_delivery`, `worker_hello`) and the slow-request
  lines (status, `tx=`, `txMs`). Name a cause only when the sequence shows
  it. For example, the post-create connect 503 followed a `worker_hello` that
  was accepted, then a 401 from the same `hello` about 6.5 s later.
- **Boat cleanup.** The sandbox list returns full IDs, and display scripts
  often truncate them. Match exactly one row by prefix and check its name
  before `DELETE`. `DELETE` needs `x-ascii-confirm-delete: <full id>` and
  `x-boat-org`.
- **Code-less errors.** `errorCode()` labels any error without a code
  `provider_request_failed`. Without `status=`, the error is ours, not Boat's
  HTTP reply. Once, Boat's new `&_generation=` query failed every wake this
  way; `boat.test.ts` holds that case. With owner approval, replay the exact
  idempotent call and redact its token before blaming the provider.
- **DB reads.** The PlanetScale MCP refuses production branches. Use a
  `pg_read_all_data` role with `ttl: 3600` from the service token, then
  delete it and confirm a 404.
