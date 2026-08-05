# Feedback worker

A Cloudflare Worker that turns the app's **Help → Feedback** submissions into
**Intercom conversations** (attributed to the submitting user), so they land in
an Intercom Inbox where an operator can reply, and where Intercom's native
**"Create with Linear Agent"** can file an informed Linear issue.

```
Feedback modal → this Worker → Intercom (contact + conversation, type-prefixed)
  → Intercom Inbox → "Create with Linear Agent" → Linear
```

The **type** (Issue / Bug / Feature request / Feedback) is always a prefix on
the conversation body (zero Intercom setup required), and _also_ a real Intercom
**tag** when `INTERCOM_ADMIN_ID` + `INTERCOM_TAG_IDS` are configured.

Privacy: the renderer scrubs "recent logs" (via `@zeros/protocol/scrub`) **before**
posting; this Worker only forwards + truncates.

This Worker is deployed standalone and is not part of the desktop app's build.
It is published here so the wire contract the app depends on is readable, not
because a fork needs to run it — the app works fine with `VITE_FEEDBACK_URL`
unset.

---

## 1. Collect the Intercom values

- **Access token:** Intercom → **Settings → Developers → Developer Hub** → the
  app → **Authentication** → copy the **Access token**.
- **Region:** `us` (default), `eu`, or `au` — must match the Intercom
  workspace's hosting region (Settings → Data → hosting).
- **(Optional) tags:** applying a real Intercom tag per type needs an **admin
  id** (Settings → Teammates, or `GET /admins`) and the **tag ids**
  (`GET /tags`). Then set `INTERCOM_TAG_IDS` to a JSON map, e.g.
  `{"bug":"111","feature":"222","issue":"333","feedback":"444"}`.

## 2. Deploy (creates the Worker)

```bash
cd apps/feedback-worker
npx wrangler@4 deploy        # NOT `pnpm deploy`. Answer "yes" to a workers.dev subdomain.
```

Save the URL it prints — it becomes `VITE_FEEDBACK_URL` in the app build.

## 3. Set secrets

```bash
npx wrangler@4 secret put AUTH0_DOMAIN       # tenant domain, no scheme (e.g. tenant.us.auth0.com)
npx wrangler@4 secret put AUTH_AUDIENCE      # the Auth0 API identifier — same value as the control plane's
npx wrangler@4 secret put INTERCOM_TOKEN     # the access token from step 1
npx wrangler@4 secret put INTERCOM_REGION    # optional: us | eu | au
npx wrangler@4 secret put INTERCOM_ADMIN_ID  # optional (enables tagging)
npx wrangler@4 secret put INTERCOM_TAG_IDS   # optional JSON map
npx wrangler@4 secret put INTERCOM_APP_ID    # optional — clickable convo links in Linear issues
npx wrangler@4 secret put LINEAR_API_KEY     # optional — create Linear issues DIRECTLY
npx wrangler@4 secret put LINEAR_TEAM_ID     # required with LINEAR_API_KEY (team UUID)
npx wrangler@4 secret put LINEAR_LABEL_IDS   # optional JSON map, e.g. {"bug":"<label-uuid>"}
npx wrangler@4 secret put POSTHOG_PROJECT_URL # optional — e.g. https://us.posthog.com/project/123
```

With `LINEAR_API_KEY` + `LINEAR_TEAM_ID` set, every submission ALSO creates a
Linear issue directly (independent of the Intercom→Linear agent below): typed
title, metadata (app version, area, verified sender, PostHog person link, Intercom
conversation link), and the app's scrubbed recent logs uploaded as a `.jsonl`
attachment (inline tail fallback). Intercom and Linear are independent
best-effort destinations — the submission succeeds if either lands.

## 4. Wire the app

Only the URL goes into the app build env:

```
VITE_FEEDBACK_URL=https://zeros-feedback.<account>.workers.dev
```

### Auth

The Worker requires a valid **Auth0 access token** — the user's own, sent as
`Authorization: Bearer …`. It verifies the signature against the tenant's JWKS
(pinned to RS256), checks issuer + audience + expiry, requires
`email_verified: true`, and takes the sender's address from the token claims.

There is deliberately **no shared secret and no `email` field in the request
body**. The previous design had both, and they combined into an impersonation
hole: the secret was inlined into the renderer bundle, so anyone with a build
could read it — and because the address was just a body field, holding the
secret let you file feedback as _any_ address, which the Worker attached to a
real Intercom contact. A secret shipped inside the client it authenticates was
never an auth boundary. Authenticating the user fixes both halves at once, and
means the address in Intercom is one Auth0 verified.

The rate limiter in `wrangler.jsonc` still runs BEFORE auth, so an
unauthenticated caller cannot make the Worker do JWKS work or burn CPU on
signature checks.

## 5. Configure Intercom → Linear (one-time)

Intercom → Settings → Integrations → **Linear**. Enable it and set up
**"Create with Linear Agent"** (optionally an automation rule so it runs on new
conversations carrying the app's tags). Status syncs back to the conversation
when the Linear issue is completed, closing the loop to the submitter. This
step needs an Intercom plan that includes the Linear integration.

## 6. Test

```bash
curl -X POST "https://zeros-feedback.<account>.workers.dev" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -d '{"type":"bug","message":"Diff view scrolls to top on save",
       "app_version":"0.1.0","area":"changes"}'
```

`$ACCESS_TOKEN` must be a real Auth0 token for `AUTH_AUDIENCE`; without one you
get a flat `401`. Expect `{"ok":true,"conversation":"…","type":"bug"}` and a new
conversation in the Intercom Inbox titled **[Bug] …**, from the address in the
token — not one you can choose.

---

## Notes

- **Contact role:** with an `email` the Worker creates a `user` (repliable by
  email); without one, an anonymous `lead` (one-way, still triaged → Linear).
- **No KV / no dedup:** every submission is intentionally its own conversation.
- **Standalone:** the Worker has no workspace runtime dependencies. The desktop
  renderer applies `@zeros/protocol/scrub` before sending the request; the
  Worker is deployed independently and is not wired into the app's build or
  release.
