# Teams — Identity, Tenancy, Billing, and the Execution Plan

*Implementation-track design doc (applies to ALL of Zeros — local and cloud) · researched fresh 2026-07-04 · renamed from `orgs-and-teams.md` on 2026-07-25 · cloud-workspace context in [cloud-workspace/](cloud-workspace/) · raw notes in [cloud-workspace/research/](cloud-workspace/research/) · bibliography at the bottom*

> **Decision update 2026-07-25 (founder direction) — "Organization" is now "Team"; the nested sub-team concept is retired.**
> 1. **One flat level.** The tenant root was an Organization that *contained* a second, nested "team" grouping. That two-level model is gone: there is now ONE container, called a **Team**, and it holds members directly. "Organization" is retired from the Zeros vocabulary entirely.
> 2. **Schema** (`backend/migrations/0006_org_to_team.sql`): `organizations`→`teams`, `organization_members`→`team_members`, `org_settings`→`team_settings`, type `org_role`→`team_role` (values unchanged: owner/admin/member), and every `org_id` column→`team_id` (6 tables). **Dropped:** the nested `teams`/`team_members` sub-tables, the old `team_role` enum of ('maintainer','member'), `invitations.team_id` (the sub-team pointer), the `one_default_team_per_org` index, and the `is_default` "Personal" row. RLS helper `app_user_org_ids()`→`app_user_team_ids()`; policies renamed to match. Audit actions `org.*`→`team.*`, with the retired sub-team actions re-keyed to `subteam.*` first so the two concepts never merge under one name.
> 3. **API + engine:** `/v1/orgs/...`→`/v1/teams/...`; `/v1/me` returns `{ user, teams }`; **all sub-team routes are gone**. The engine's settings layer `org`→`team` (default < user < **team** < repo < repo-local < workspace-local < managed); RPC `org.setContext`→`team.setContext` with param `teamId`. UI: Settings → Administration → **Team** + **Members**; the "Teams" sub-section inside Members is gone.
> 4. **The default-team invariant no longer exists** — there is no default team to protect (this retires the last surviving piece of Part B). Surviving invariants: last-owner protection, hashed single-use invitations, enumeration-safe responses, JIT user mirroring, RLS as the second lock.
> 5. **The Organization-era contract is gone.** `/v1/orgs/*` and the legacy `org`/`orgs` response keys were a deliberate shim, because the control plane auto-deploys off `main` while the desktop app does not — the forcing case being invite-accept, which commits the membership and burns the single-use token *before* the client reads the body, so a missing `org` key left the user silently a member holding a dead link. The Team contract shipped in the app as **v0.0.16** (2026-07-25) and the shim was deleted the same day, so the cutover is safe only once installed clients have actually rolled past v0.0.16 — **judge that from client versions hitting the API, not from the absence of log lines.** The shim's `[compat]` warning deduped once per path per process, so quiet logs proved the process had restarted, not that legacy traffic had stopped. `/v1/teams/*` is now the only surface.

> **Decision update 2026-07-22 (founder direction) — orgs are now OPTIONAL; this REVERSES Part B's auto-create recommendation.**
> 1. **No personal org is auto-created at sign-in.** Billing will attach to a person OR an org separately, so an org exists only when the user explicitly creates one (Settings → Administration → "+ Create organization", or the org switcher) or accepts an invitation. `is_personal` was dropped from the schema (`backend/migrations/0005_orgs_optional.sql`); existing personal orgs became ordinary orgs, deletable by their owner like any other.
> 2. **The shared-secrets vault (O4's `org_secrets` + envelope encryption + spawn-time injection) was removed end-to-end** — table, API routes, `VAULT_MASTER_KEY`, client sync, and the engine's org-secret env source. The org settings **doc** layer (`org_settings`) remains. Revisit later if team-shared credentials return as a feature.
> 3. Settings UI: Administration now has two tabs — **Organization** (logo · name · ID · danger-zone delete, plus the org switcher) and **Members** (invites, roles, pending, teams, join). Orgs gained a `logo` column (validated raster data-URL; SVG excluded).
> The invariants that survive unchanged: last-owner protection, default-team protection, hashed single-use invitations, enumeration-safe responses, JIT user mirroring.

Confidence labels follow the pack convention: **verified** = confirmed on official docs or 2+ independent sources; **likely** = single credible source or widely-observed behavior; **our analysis** = synthesis/recommendation, not a sourced fact.

---

## Executive summary

Every serious product studied — **Linear, Figma, OpenAI, Anthropic (plus Vercel as a fifth reference)** — converges on the same shape: a **two-level container hierarchy** (organization → team/workspace), **billing attached to the organization**, **roles at both levels**, and — critically for Arun's question — **a default container auto-created for every account, including individuals**. Linear auto-creates a default team named after the workspace; Anthropic's Console gives every organization a "Default Workspace" that cannot be deleted; OpenAI assigns every API account a default organization (historically labeled "Personal"); Vercel went the furthest and quietly turned *every personal account into a team* ("Hobby team"). **The verdict as researched (2026-07-04) was: yes — auto-create a container for every Zeros user, hang billing off it, and auto-create one default sub-container named "Personal."**

**Both halves of that verdict have since been reversed** (see the dated blocks above): 2026-07-22 made the container optional — nothing is auto-created — and 2026-07-25 deleted the sub-container level outright. What survives from the study is the part that actually mattered: **one container owns billing, policy, membership, and the record**, and every tenant-owned row points at it. In Zeros that container is now called a **Team**, it is created explicitly, and it holds members directly.

On infrastructure: **Supabase-for-auth-only + Railway Postgres as the source of truth is a sound, portable architecture** — Supabase now issues asymmetric-key JWTs verifiable via a public JWKS endpoint, so your Railway backend verifies logins locally with zero Supabase coupling beyond "it signs tokens." Two honest costs: (1) this **revises the 2026-07-02 decision note**, which leaned Supabase-as-record with Railway as fallback — the flip is explicitly allowed by that note ("ElectricSQL runs on any Postgres… the sync-engine choice doesn't lock the DB host"), but part 04/07/08 need a dated update; (2) Railway's Postgres is an **unmanaged template** with a documented data-corruption history and only-recently-shipped HA (experimental, 2026-03) and PITR (2026-05, Pro plan) — running the record there is acceptable **only with PITR on + nightly off-platform dumps**.

The full plan below delivers: the pattern study, the shipped schema (8 tables, post-rename DDL included), the auth and authorization design, a security checklist (invitations, audit log, last-owner protection — the shared-secrets vault was removed 2026-07-22 and is kept below as history), the billing model (one Stripe customer per team, seat quantity on one subscription, webhooks as truth), and a 6-phase execution plan that slots into the pack's existing Phase 4 (control plane) and Phase 8 (collaboration).

---

## Part A — How Linear, Figma, OpenAI, and Anthropic actually model it

### Linear: workspace → teams, roles at both levels

Linear's tenant is the **workspace**; inside it, **teams** group people and own issues. The detail that matters most for Zeros: **"When a workspace is created, Linear automatically creates a default Team with the same name as the workspace"** (**verified** — Linear docs). Nobody in Linear exists outside a team; the default team makes the single-user and day-one experience identical to the team experience.

Roles are **workspace-level**: Admin (routine administration), Member (standard collaboration), Guest (Business/Enterprise plans; restricted to specified teams — contractors and clients), and a **Workspace Owner** super-role on Enterprise only, holding the most sensitive powers: billing, security, audit log, exports (**verified** — Linear members/roles docs). At the **team level**, any member can be promoted to *team owner* by an existing team owner or a workspace admin. Billing is **per user, per workspace** ($10/user/month annual on Business) — the workspace is the billing entity, teams are free structure inside it (**verified** — Linear pricing).

**Takeaways for Zeros:** default team at org creation; guests as a *workspace role* that restricts team visibility (not a separate system); the owner/admin split — owner for billing + security, admin for day-to-day — is worth adopting from day one because retrofitting a super-role later is painful.

### Figma: organization → (workspaces) → teams → projects → files

Figma's hierarchy is the deepest: **Organization → Workspaces (Enterprise only) → Teams → Projects → Files** (**verified** — Figma Learn). Two admin species exist — organization admins (members, resources, billing, org-wide settings) and workspace admins (Enterprise; manage seats and default teams for their slice). Every team has **exactly one owner** (transferable), plus team admins with settings rights.

Figma's most instructive idea is that **billing is explicitly separated from permissions**: "A paid seat gives someone access to Figma products, while permissions determine what they can do" (**verified**). Seats come in tiers (Full, Dev, Collab, free View seats), and who manages seats moves up the hierarchy with plan size (team admins on Professional, org admins on Organization/Enterprise).

**Takeaways for Zeros:** don't couple "can access" with "is paid for" in the schema — a `seat_type`/entitlement axis separate from `role` costs one column now and enables free viewers + paid editors later. Skip the 4-level hierarchy; Figma itself only unlocks workspaces at Enterprise.

### OpenAI: organization → projects, and the "Personal" default

On the API platform, the container is the **organization**, subdivided into **projects** ("organize work, manage access and limits, provision service accounts, track usage/billing per project" — **verified**, OpenAI help). Every account has a **default organization** ("your default organization can be updated in your profile" — **verified**), and every organization gets a **"Default project" that cannot be deleted** (**verified**). New individual API accounts historically land in an org labeled **"Personal"** (**likely** — widely observed; OpenAI's own help article on default orgs confirms the default-org mechanism but the 403'd page prevented confirming the label from the primary source).

Role design is deliberately minimal: organizations have **owner/reader**, projects have **owner/member** (**verified**). In ChatGPT Business, workspace roles are owner/admin/member with per-invite seat types (**verified**).

**Takeaways for Zeros:** the *undeletable default sub-container* pattern appears here **and** at Anthropic — it removes an entire class of "container is empty/missing" edge cases. Minimal role sets age better than rich ones.

### Anthropic: organization → workspaces, six roles, separated admin plane

Anthropic's Console organizes by **organization → workspaces**: "Every organization has a **Default Workspace that cannot be renamed, archived, or deleted**"; additional workspaces carry their own API keys, members, and resource limits (**verified** — Claude help center + platform docs). Six org roles exist (User, Claude Code User, Limited Developer, Developer, Billing, Admin), with two structural rules worth copying: **Admin and Billing roles are automatically granted on all workspaces and cannot be removed from them** (no "locked out admin" states), and **API keys are scoped to a workspace** with full-access vs read-only permission levels (**verified**).

The standout security decision: the **Admin API requires a special admin key (`sk-ant-admin…`) that only org admins can provision** — management-plane credentials are a physically different kind of secret from data-plane keys (**verified**).

**Takeaways for Zeros:** dedicated `Billing` role concept (finance people shouldn't need Admin); admin operations on a separate, clearly-marked credential type; org-wide roles transcend team membership.

### The pattern, distilled

| Dimension | Linear | Figma | OpenAI | Anthropic | → Zeros recommendation |
|---|---|---|---|---|---|
| Tenant / billing entity | Workspace | Organization | Organization | Organization | **Team** |
| Sub-container | Team | Team (+Workspaces on Ent.) | Project | Workspace | **None — retired 2026-07-25** (one flat level) |
| Auto-created default | Team named after workspace | — (drafts space) | "Default project", undeletable | "Default Workspace", undeletable | **None — teams are created explicitly** (2026-07-22) |
| Org roles | Owner*/Admin/Member/Guest | Org admin/member | Owner/Reader | 6 roles incl. Billing | **owner / admin / member** (+ `billing` later) |
| Team roles | Team owner/member | Owner(1)/Admin/Member | Owner/Member | n/a (membership only) | **n/a — retired** (no second level to hold roles) |
| Billing unit | Per user | Per seat, tiered types | Per usage/project budgets | Per usage + seats | **Per seat (Stripe), usage later** |
| Individual users | Same workspace model | Drafts + teams | Default "Personal" org | Org with Default Workspace | **Zero teams is a supported state; a solo team is an ordinary team** |

(*Enterprise only. Sources: Linear docs [1][2][3], Figma Learn [4][5][6], OpenAI help [7][8][9], Anthropic help/docs [10][11][12]. The four vendor columns describe **their** products and are left exactly as researched; only the Zeros column tracks our decisions.*)

---

## Part B — Arun's question: default org + a team named "Personal"? *(SUPERSEDED — kept as history)*

> **Both recommendations in this Part have been reversed and are no longer the product.** The auto-created container went on 2026-07-22 (teams are optional; none is created at sign-in). The default sub-container named "Personal" went on 2026-07-25, together with the entire nested sub-team level it lived in — there is now one flat Team, so there is nothing for a default to be a default *of*, and the "undeletable default" invariant below no longer exists in the schema or the API.
> The Part is left intact rather than deleted because the reasoning is still the honest record of *why* we started here, and the industry precedents it cites (Linear, Vercel, OpenAI, Anthropic) remain accurate statements about those products. Read it as of 2026-07-04.

**Yes to both — this is exactly the industry pattern, with two refinements.**

**Auto-create the organization, always.** Every product studied puts *every* user, including individuals, inside the tenant container, because billing, quotas, security policy, and (for Zeros) the cloud record and org settings layer all need one stable anchor. Vercel is the strongest precedent: its docs now speak of "your **Hobby team**" for what used to be a bare personal account — they retrofitted org-ness onto individuals because not having it hurt (**verified** — Vercel account docs). OpenAI's "Personal" org label is the naming precedent (**likely**). Retrofitting orgs onto org-less users is one of the most painful migrations in SaaS; creating them on day one costs two `INSERT`s.

**Refinement 1 — naming.** Name the auto-org after the person (e.g., "Arun's Org", editable), and name the auto-team **"Personal"**. Avoid naming the *org* "Personal": when the user later invites teammates and renames the org to their company, a team called "Personal" inside "Acme" still reads naturally (Linear's rename flow has exactly this awkwardness — the default team keeps the old workspace name until manually renamed).

**Refinement 2 — hide the machinery from individuals.** The org and default team exist in the schema from the first second, but the Settings UI shows no "Teams" section until the org has ≥2 members or the user explicitly creates a team (**our analysis**). Individuals should never *feel* the enterprise scaffolding — Linear pulls this off by making the default team invisible-by-ubiquity; ChatGPT's personal tier simply doesn't render workspace chrome.

Make the default team **undeletable** (OpenAI/Anthropic pattern) — the invariant "every org has ≥1 team; every member belongs to ≥1 team" removes empty-container edge cases from every downstream query.

---

## Part C — Auth architecture: Supabase-auth-only + Railway Postgres

### The verdict on Arun's instinct

**Sound, and increasingly standard.** The design: Supabase Auth (GoTrue) handles sign-up/sign-in (email OTP, GitHub, Google — what Zeros already ships), and *everything else* — users mirror, teams, memberships, settings, the cloud record — lives in **Railway Postgres behind your own backend**. What makes this clean in 2026 is Supabase's **asymmetric JWT signing keys**: each project exposes a public **JWKS endpoint**; your backend fetches it once, caches the public keys, and verifies every request's JWT **locally — no Supabase round-trip, no shared secret** (**verified** — Supabase signing-keys docs + blog). Key rotation is handled by the `kid` header: an unknown `kid` triggers one JWKS re-fetch.

**Lock-in analysis (the reason Arun chose this): correct.** The only Supabase-specific surface is "JWTs signed by this issuer." GoTrue is open-source and self-hostable; and because verification is standard OIDC-style JWKS, swapping to self-hosted GoTrue, Better Auth, or an enterprise IdP later means changing an issuer URL + JWKS URL in the backend config — the schema, backend, and record never change (**verified** mechanics; migration ease **our analysis**). Supabase Auth is free to 50,000 MAU (100k on the $25 Pro plan, then $0.00325/MAU) — auth-only usage costs approximately nothing for years (**verified** — Supabase pricing). One caveat: free-tier projects **pause after 7 days of inactivity** — a login-only project still gets traffic, but the Pro plan removes the risk for a production auth plane (**verified**).

### The four rules that keep it safe

1. **JWT = identity only. Postgres = authorization.** Put `sub` (user id) and email in the token; look up team membership and role **in the database on every request**. Baking roles/team lists into JWT claims goes stale for up to an hour after a role change or removal — an actual revocation hole. Membership lookups are one indexed query; cache in-process for ≤30s if ever needed (**our analysis**, consistent with the RBAC literature's "always re-check server-side" [15][16]).
2. **JIT user mirroring, not webhooks.** On any authenticated request whose `sub` has no row in `users`, upsert it from the verified token (id, email) — "just-in-time provisioning." No webhook infrastructure, no sync drift; Supabase's user table stays a login cache rather than a second source of truth (**our analysis**; standard third-party-auth pattern [13]).
3. **Verify, never decode.** The backend rejects anything that fails signature/expiry/issuer/audience checks; never trust client-supplied user ids. All bridge/relay calls from the Mac app carry the JWT — this is the same "per-user identity on the connection" that pack part 05 already assigns to Phase 8.
4. **The engine keeps its own check.** Cloud engines (and later, paired local engines) verify the same JWKS-signed tokens before accepting a WSS connection — one issuer, one verification story, everywhere.

---

## Part D — The schema (Railway Postgres, source of truth)

Shared-schema multi-tenancy — one database, one set of tables, `team_id` on every tenant-owned row — is the 2025/26 consensus for this scale: lowest operational overhead, centralized migrations, scales to very large tenant counts before sharding matters (**verified** — multi-tenant Postgres literature [14][17]; Citus-style `tenant_id` distribution is the later scale-out path). The DDL below is the **shipped schema as of migration 0006** (the rename), flattened into one readable listing rather than the 0001→0006 sequence; commentary follows.

```sql
-- Identity mirror (JIT-provisioned from verified Supabase JWTs)
CREATE TABLE users (
  id          uuid PRIMARY KEY,          -- = Supabase auth.users.id (the JWT `sub`)
  email       citext NOT NULL UNIQUE,
  display_name text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz                -- soft delete; row keeps FK integrity
);

-- Tenant root: the billing + policy + record anchor. ONE level — a team
-- holds members directly; there is no sub-container (0006).
CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        citext NOT NULL UNIQUE,    -- url-safe, rename-safe (id is the identity)
  name        text   NOT NULL,
  logo        text,                      -- small raster data: URL (png/jpeg/webp; NEVER svg)
  created_by  uuid   NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TYPE team_role AS ENUM ('owner','admin','member');  -- add 'billing','guest' later

CREATE TABLE team_members (
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       team_role NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members (user_id);   -- "my teams" lookup

-- Invitations: token is NEVER stored raw (store SHA-256 of it, like a password)
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        team_role NOT NULL DEFAULT 'member',
  token_hash  bytea NOT NULL UNIQUE,     -- sha256(32-byte random url token)
  invited_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_pending_invite
  ON invitations (team_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Team settings layer (feeds the engine's resolve chain: user < TEAM < repo < local)
CREATE TABLE team_settings (
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  scope      text NOT NULL DEFAULT '*',  -- '*' = team-wide, or a repo slug
  doc        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- same shape as settings.toml tree
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, scope)
);

-- Append-only audit trail (Linear gates this to Enterprise; Zeros gets it free)
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id    uuid NOT NULL,
  actor_id   uuid,                             -- null = system
  action     text NOT NULL,                    -- 'team.created', 'member.invited', …
  subject    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_team_idx ON audit_log (team_id, created_at DESC);

-- Billing mirror (Stripe webhooks write here; app reads entitlements, never Stripe)
CREATE TABLE billing_customers (
  team_id            uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE
);
CREATE TABLE billing_subscriptions (
  id                     text PRIMARY KEY,   -- Stripe subscription id
  team_id                uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  status                 text NOT NULL,      -- active/trialing/past_due/canceled
  plan                   text NOT NULL,      -- 'free','pro','business'
  seats                  int  NOT NULL DEFAULT 1,
  current_period_end     timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_subscriptions_team_idx ON billing_subscriptions (team_id);
```

**What is deliberately NOT in this schema anymore** (each line is a reversal of an earlier recommendation in this doc, kept explicit so nobody re-derives it):

| Gone | Was | Retired by |
|---|---|---|
| `organizations` / `organization_members` / `org_settings` | the tenant root's old names | 0006 — renamed to `teams` / `team_members` / `team_settings` |
| The nested sub-team `teams` + `team_members` tables, and `CREATE TYPE team_role AS ENUM ('maintainer','member')` | the second container level | 0006 — dropped; the names were freed and immediately reused by the tenant root |
| `invitations.team_id` (the sub-team pointer) | "invite straight into a sub-team" | 0006 — there is no sub-team to land in |
| The sub-team's `is_default` column + `one_default_team_per_org` | the undeletable "Personal" team | 0006 — no default team exists, so **default-team protection is no longer an invariant** |
| `organizations.is_personal` + `one_personal_org_per_user` | the auto-created container | 0005 (2026-07-22) — containers are created explicitly |
| `org_secrets` | the shared-secrets vault | 0005 (2026-07-22) — removed end-to-end (table, routes, master key, engine source) |

**RLS objects, post-0006:** the helper is `app_user_team_ids()` (SECURITY DEFINER, returns the caller's `team_members.team_id` set — it replaced `app_user_org_ids()`, which had to be *recreated* rather than renamed because a `LANGUAGE sql` body is stored as text and would still have read `FROM organization_members`). Policies: `users_rw`, `teams_rw`, `team_members_rw`, `invitations_rw`, `team_settings_rw`, `audit_log_rw`, `billing_customers_rw`, `billing_subscriptions_rw` — each `USING (app_is_system() OR team_id IN (SELECT app_user_team_ids()))`, with the billing pair write-locked to the system path.

**Audit actions, post-0006:** `team.created` · `team.renamed` · `team.logo_updated` · `team.deleted` · `member.invited` · `member.joined` · `member.role_changed` · `member.removed` · `member.left` · `invitation.revoked` · `settings.updated`. Historical rows were re-keyed in two ordered `UPDATE`s: the retired sub-team actions moved `team.*` → **`subteam.*`** *first*, then the tenant-root actions moved `org.*` → `team.*`. Reversing that order would have merged two different concepts under one name.

**Wiring to what exists:** the pack's `cloud_workspaces` registry (part 07/08) gains `team_id uuid NOT NULL REFERENCES teams(id)` — one pointer now, not two, since there is no sub-container to also point at. Conductor's local DB showed the same shape (its migration #114 "track owning organization for cloud workspaces" and #115 "assignee and watchers" — see the Conductor DB audit, 2026-07-04; *Conductor's* naming is its own). The cloud-record chat/session tables similarly carry `team_id` as their tenancy key.

**Design notes (the why):**
- **`citext` for emails/slugs** kills case-duplication bugs at the type level.
- **Composite PK on the membership table** — `(team_id,user_id)` — makes double-membership impossible and is the exact index authorization queries need.
- **Soft-delete users, hard-cascade memberships.** Chat history (the record) must survive a departed member; their `users` row remains (name for attribution), their memberships cascade away (access gone). Teams soft-delete too (`deleted_at`), and deleting one revokes its pending invitations in the same transaction so no live join link outlives the team.
- **Slugs are allocated with a retry**, not a check-then-insert: `INSERT … ON CONFLICT (slug) DO NOTHING` doesn't abort the transaction, so a collision re-tries with a fresh random suffix instead of 500-ing.
- **Every table with tenant data carries `team_id`** — including future tables. This is the one schema rule that is *never* worth bending (**verified** consensus [14][17]).
- *(The `users` table above is shown as of 0001. Migration 0003 later decoupled `users.id` from the auth provider's subject and added a `user_identities` table — orthogonal to this rename and not re-documented here.)*

---

## Part E — Backend functions and the authorization spine

The backend is one small always-on service on Railway (the same control-plane service part 07/08 already plans — Fastify/Hono + `pg`, ~$5–20/month at Zeros' scale per the Railway research note). Its team API, as shipped (`backend/src/routes.ts` is the authoritative surface):

```
GET    /v1/me                          { user, teams } — my teams + my role in each

POST   /v1/teams                       create (any authenticated user; creator becomes owner)
PATCH  /v1/teams/:team                 rename and/or set/clear logo   (admin+)
DELETE /v1/teams/:team                 soft-delete + revoke its pending invites  (owner)

GET    /v1/teams/:team/members         list                 (member+)
PATCH  /v1/teams/:team/members/:user   change role          (admin+; owner rules below)
DELETE /v1/teams/:team/members/:user   remove               (admin+, or self-leave)

POST   /v1/teams/:team/invitations     invite email+role    (admin+; 20 / 10 min)
GET    /v1/teams/:team/invitations     pending list         (admin+)
DELETE /v1/teams/:team/invitations/:id revoke               (admin+)
POST   /v1/invitations/accept          body: raw token      (any authed user; 30 / 10 min)

GET    /v1/teams/:team/settings?scope=…  read the team settings doc   (member+)
PUT    /v1/teams/:team/settings          write it (body: scope, doc)  (admin+)

— planned, not yet built (O5) —
POST   /v1/billing/checkout            Stripe Checkout session     (owner/admin)
POST   /v1/billing/portal              Stripe customer portal      (owner/admin)
POST   /v1/webhooks/stripe             webhook sink (signature-verified)
```

**Routes that no longer exist.** Every `/v1/orgs/...` path is gone (renamed to `/v1/teams/...`), and with them the entire sub-team family — `POST|PATCH|DELETE /v1/orgs/:org/teams[...]` and its member add/remove pair. `/v1/me` returns `{ user, teams }` where it once returned `{ user, orgs }`. The secrets-vault routes (`/v1/orgs/:org/secrets…`) went earlier, on 2026-07-22.

**The authorization spine is one middleware, one query.** Verify JWT → JIT-upsert user → open a transaction bound to the caller → load `(team_id, role)` for the `:team` in the path → handlers declare a minimum role. Two helpers (`requireMembership(tx, team, user)` and `requireRole(tx, team, user, 'admin')`), used everywhere, reviewed once. Every mutation and its audit row land in the *same* transaction. The RBAC literature's strongest advice is exactly this centralization: roles scoped to the tenant id, checked server-side on every request, never inferred from the client (**verified** [15][16]).

**The invariants enforced in transactions, not in UI:**
- **Last-owner protection.** `assertNotLastOwner` takes a row lock on the **team** (`SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`) before counting owners, so two owners leaving concurrently cannot both observe "count = 2" and both commit to zero. The per-member `FOR UPDATE` the callers already hold locks *different* rows and does not serialize distinct owners — the team row is what they contend on. Vercel encodes the same rule ("you can't leave a team if you are the last remaining owner" — **verified**).
- **Owner changes are owner-only.** An admin may not mint, demote, *or remove* an owner; self-leave stays allowed for one's own row.
- **~~Default-team protection~~ — RETIRED 2026-07-25.** This was the OpenAI/Anthropic undeletable-default pattern, and it no longer applies: there is no default team, no `is_default` column, and any team is deletable by an owner. Recorded here rather than deleted because it was a named invariant in every prior revision of this doc.

**Team creation is the one system-context write** (there is no signup transaction anymore — nothing is auto-created at sign-in). It runs under the system path because a brand-new team can't pass a user-context RLS `USING` check on the row being inserted, and the owner-membership bootstrap can't see a team it isn't yet a member of: `INSERT teams (slug, name, logo, created_by)` (with slug-collision retry) → `INSERT team_members (role: 'owner')` → audit `team.created`. No team-scoped authz applies — any authenticated user may create a team; the input is Zod-validated and `created_by`/audit are stamped server-side.

**Row-Level Security as the second lock.** Every request runs inside `withUserTx`/`withSystemTx`, which opens a transaction, drops to the unprivileged `zeros_app` role (`SET LOCAL ROLE`), and sets the `app.user_id` (or `app.system`) GUC that the policies key on — so tenant tables enforce `USING (app_is_system() OR team_id IN (SELECT app_user_team_ids()))` regardless of what the handler forgot. The 2025/26 consensus is blunt: in shared-schema multi-tenancy "RLS is not optional — it's the last line of defence" against the one forgotten `WHERE` clause (**verified** [14][17]). This is plain Postgres RLS — it works identically on Railway, a future VPS, or RDS; nothing vendor-specific about it.

**Two ordering rules the RLS lock imposes on handlers**, both found in review and worth restating because they look like style choices and are not: (1) on **self-leave**, the audit row must be written *before* the membership row is deleted — once the actor's `team_members` row is gone, `app_user_team_ids()` no longer contains the team and the audit `INSERT` fails its own policy, rolling the whole leave back. (2) On **invite accept**, the lookup joins live teams and locks `FOR UPDATE OF i, t` so a concurrent team-delete re-evaluates on lock acquisition and the accept sees the row vanish instead of joining a soft-deleted team.

---

## Part F — Security checklist (the parts that get products breached)

**Invitations** (the classic weak point; every rule below is the published consensus [18][19]):
- Token = **32 bytes of CSPRNG randomness**, URL-safe encoded; the database stores only its **SHA-256 hash** — a DB leak must not leak join links.
- **7-day expiry, single-use**, revocable; the token row binds email + team + role + inviter, and all of it is re-validated at redemption. Re-inviting the same address rotates the token (the old one is revoked in the same transaction).
- **Accept flow binds to the signed-in user**: accepting while signed in as a different email than the invite's shows an explicit "this invite is for X, you are Y" interstitial — the documented account-takeover path is an invite silently accepted by the wrong session (**verified** [18]).
- **No enumeration**: inviting an address returns the identical response whether or not that email already has a Zeros account; timing differences count as leaks too (**verified** [19]).
- Delivery via the deep link Zeros already ships (`zeros://` handler; the dev-instance callback-routing lesson from the login work applies here).

**The secrets vault** *(REMOVED 2026-07-22 — kept as history; nothing below is in the product)*. The feature was deleted end-to-end: the `org_secrets` table, its API routes, `VAULT_MASTER_KEY`, the client sync, and the engine's team-secret env source. A team now influences a member's environment only through its settings doc's `[env]` table, which spawn-env hazard-filters like any other layer. The design, if shared credentials ever return:
- **Envelope encryption**: each secret is encrypted with its own random data key (AES-256-GCM); the data key is encrypted by a **master key held only in the backend service's environment** (Railway env var now; KMS/HSM later — a `key_version` column makes master rotation a background re-wrap, not a migration). The database alone can never decrypt anything.
- **Write-only UI**: after saving, members see the secret's *name* and metadata, never the value — same UX as the engine's existing `<redacted>` mask for repo env secrets.
- **Decryption happens exactly once per spawn**: the engine (cloud sandbox, or the local engine acting for a member) calls `secrets:resolve` with its authenticated identity; values are injected into the workspace process environment and never written into any settings.toml, never into git, never into the record's chat tables.
- Every read/write of a secret appends to `audit_log`.

**Platform hygiene:**
- **Admin-plane separation** (Anthropic's `sk-ant-admin` lesson): if Zeros ever ships programmatic team management, those keys are a distinct type with a distinct prefix, provisionable by owners only (**our analysis**, from [12]).
- **Rate-limit** invitation sends and accept attempts per user+team; log rejects. (Shipped: 20 invite-creates / 10 min, 30 accepts / 10 min.)
- **Server-stamped authorship**: `sender_id`/`author_user_id` on record writes comes from the verified JWT server-side, never from the client — already a Phase 8 line item in part 05; teams make it load-bearing.
- **Webhook signature verification** on the Stripe sink; idempotent event handling (Stripe retries).

---

## Part G — Billing: the team is the customer

The studied products agree: **billing attaches to the tenant container** — Linear bills the workspace per user [3], Figma bills org/team seats [5], OpenAI/Anthropic bill the organization with per-project/workspace budgets [8][11]. For Zeros:

- **One Stripe Customer per team** (`billing_customers.team_id`), created lazily at first upgrade — free teams never touch Stripe. Since 2026-07-22 a person can also exist with **zero** teams, so the billing model must attach to a *person or a team* separately; the team side is what this Part describes.
- **One subscription, seat quantity = paid members.** The published Stripe pattern: a single per-seat Price; adding/removing a member updates the subscription `quantity` rather than juggling multiple subscriptions (**verified** [20][21]). Zeros' hybrid future (seats + sandbox compute usage) is Stripe's own recommended trajectory for AI SaaS — usage-based items attach to the same subscription later (**verified** [22]).
- **Webhooks are the source of truth, never client callbacks** (**verified** [20]): `checkout.session.completed`, `customer.subscription.updated/deleted` write `billing_subscriptions`; the app reads *only* the local mirror (entitlements), so a Stripe outage degrades to "can't change plan," never "can't work."
- **Enforcement lives where the data is**: seat count checked at invite-accept time (block accept when `members ≥ seats`, with an upgrade prompt to admins); plan gates (team size, audit retention, SSO-later) read `billing_subscriptions.plan`.
- The **Billing role** (Anthropic's separate finance role) is a later enum value, not a schema change.

---

## Part H — Railway as the source of truth: audit of Arun's infra call

**The decision delta, stated plainly.** The pack's 2026-07-02 decision note recommends Supabase as "auth + THE RECORD host," with "Railway stays the fallback Postgres / worker host." Arun's new call — **Railway Postgres as the record + Supabase for auth only** — is *within* that note's own escape hatch ("ElectricSQL runs on any Postgres (Supabase or Railway), so the sync-engine choice doesn't lock the DB host"), and this document formally makes the flip. Parts 04/07/08 need a dated note; nothing else in the pack's architecture changes, because every component (JWKS auth, plain-Postgres RLS, ElectricSQL, pgBackRest-style backup) is host-agnostic.

**Why the flip is reasonable (our analysis):**
- **Portability is maximal.** Plain Postgres + your own backend container = `pg_dump` and redeploy anywhere (VPS, Fly.io, RDS) — which is *also* the enterprise self-host story from decision 2: "self-hosting = pointing Zeros at their database." Supabase-as-record would have entangled the record with Supabase's PostgREST/RLS-on-auth.uid conventions; auth-only keeps the blast radius to one issuer URL.
- **One fewer split-brain.** Backend and DB co-located on Railway's private network; Supabase does the single stateless thing (sign JWTs) that's verified locally anyway.

**Why it needs guard-rails (verified, from the pack's own Railway research note, 2026-07-02):**
- Railway's Postgres is officially an **unmanaged template** — "you have total control over configuration and maintenance," i.e., backups and upgrades are on you.
- Community analysis through 2026-02 catalogued **309 forum threads about data loss/corruption**, including auto-updated images corrupting data directories (**likely** — single detailed analysis, consistent with many threads).
- **HA shipped 2026-03-13 as experimental** ("not production-ready" at launch); **PITR shipped 2026-05-15** (pgBackRest, weekly full + daily incremental, ~4-week window, Pro plan).

**The guard-rails (non-negotiable if the record lives here):**
1. **Pro plan + PITR enabled from day one** (it is not retroactive).
2. **Nightly `pg_dump` shipped OFF Railway** (Cloudflare R2/S3) with restore drills — the pack's "periodic export as safety net" line item, now concrete.
3. **Pin the Postgres image version**; never accept auto major-version bumps (the documented corruption vector).
4. **Re-evaluate at ~1k teams**: managed Postgres (Neon, Crunchy, RDS) is a `pg_dump` away precisely because of this architecture — treat Railway as the current host, not the marriage.

**Supabase-side residual risks:** free-tier project pausing (use Pro for the auth project, $25/mo) and MAU pricing at scale (50k free / 100k Pro — years of headroom). GoTrue is open-source if self-hosting auth ever matters (**verified**).

---

## Part I — Execution plan

Phases are additive, each shippable alone; sizes assume the current codebase (Supabase auth already in the app; settings drill-in UI shipped 2026-07-04; engine settings resolver + env-secret sentinel already exist). Phase numbers continue the pack's plan (part 07); O-phases can start **before** cloud workspaces v1 because only O4's engine hook and O5's seat checks touch the sandbox path.

| Phase | Scope | Deliverables | Size |
|---|---|---|---|
| **O0 — Control-plane skeleton** | Railway service + DB | Fastify/Hono service; Railway Postgres (Pro, PITR on, pinned image); migrations runner; JWKS verify middleware + JIT user mirror; health/audit plumbing; nightly off-platform dump job | ~1 wk |
| **O1 — Teams + membership** | Schema + API | Full Part-D DDL + RLS policies; team/member endpoints; last-owner invariant; unit tests on the invariants. *As shipped: no signup transaction (2026-07-22 made teams explicit) and no sub-team endpoints or default-team invariant (2026-07-25 flattened the model)* | ~1–1.5 wk |
| **O2 — Settings UI: Administration** | Mac app | An "Administration" group in the settings sidebar (the drill-in pattern just shipped for Repos), two tabs: **Team** (logo · name · ID · your role · danger-zone delete, plus the team switcher that also creates teams) and **Members** (invite composer, member list with role changes, pending invites, join-by-link). *The nested "Teams" sub-section is gone (2026-07-25); with zero teams the whole group is replaced by Create/Join entries* | ~1 wk |
| **O3 — Invitations** | API + app + email | Token issue/hash/expiry/revoke; email send; `zeros://` accept deep link + wrong-account interstitial; pending-invite UI; enumeration-safe responses; rate limits | ~1 wk |
| **O4 — Team settings layer** | Backend + engine | `team_settings` doc + the engine's `team` layer in the resolve chain (default < user < **team** < repo < repo-local < workspace-local < managed), couriered by the renderer over the local-only `team.setContext` bridge op. *The `org_secrets` vault half of this phase was removed 2026-07-22 (Part F)* | ~1.5–2 wk |
| **O5 — Billing** | Stripe | Customer-per-team, seat subscription, Checkout + Portal, webhook sink → `billing_subscriptions`, seat enforcement at invite-accept, plan gates | ~1–1.5 wk |
| **O6 — Later** | — | `billing`/`guest` roles, SSO/SAML (WorkOS-class add-on), SCIM, audit-log UI, per-repo access control within a team, team-managed policy → the engine's existing `managed` layer | post-v1 |

**The engine tie-in (O4), precisely.** The renderer owns the control-plane session, so *it* fetches the active team's settings doc and couriers it into the engine's in-memory slot via `team.setContext { teamId, doc }`. Three properties are load-bearing:
- **Local-only.** The op rejects remote callers outright (on top of the deny-by-default remote allowlist) — a paired remote device must never plant settings that feed agent spawns on this machine.
- **Memory-only, and cleared on sign-out.** The doc is never written to disk or into any settings.toml. Signing out couriers an *empty* context so one account's team settings can't linger into the next.
- **The `team` layer is NOT trusted for credential redirection.** `team` is deliberately absent from `CREDENTIAL_REDIRECT_TRUSTED_LAYERS` (only `user` and `managed` are in it): the team layer is cloud-pushed by whichever team the member's login belongs to — a *different party* from the machine owner, unlike `managed`, which is a local MDM file. Letting it set `ANTHROPIC_BASE_URL` / `HTTP_PROXY` / `NODE_EXTRA_CA_CERTS` would let a team reroute a member's credential-bearing agent traffic to a team-controlled host. The same reasoning makes `providers` user-only in the `team` layer.

**Total: ~6–8 weeks** of focused work for O0–O5 (**our analysis**). Dependencies on the pack's existing plan: O0 *is* the Phase-4 control plane started early; the cloud-record tables land in the same database with `team_id` from birth (no tenancy retrofit); Phase 8 collaboration inherits identity, membership, and server-stamped authorship from O1/O3 instead of building them mid-phase.

**Decision-register updates this document implies:**
1. ~~DECIDED: default org per user (`is_personal`), default undeletable team "Personal", org = billing entity.~~ **REVERSED in two steps.** 2026-07-22: nothing is auto-created; `is_personal` dropped. 2026-07-25: the tenant root is a **Team**, the nested sub-team level and its undeletable "Personal" default are deleted, and the team is the billing entity (alongside a person — billing may attach to either).
2. DECIDED: Supabase = auth issuer only; **Railway Postgres = the record + team store**, with the Part-H guard-rails. Parts 04/07/08 get a dated note (the pack convention for reversals).
3. ~~DEFERRED: visible Teams UI until ≥2 members~~ — moot: there is no sub-team UI to gate. Still DEFERRED: billing/guest roles; SSO/SCIM.

---

## Limitations & caveats

Vendor docs describe *behavior*, not internals — the Linear/Figma/OpenAI/Anthropic schemas above are inferred from their documented models, not from their code; where a label mattered (OpenAI's "Personal" org name) and the primary page was unreachable (403), it is marked **likely**, not verified. Sizes in Part I are founder-planning estimates, not commitments. The Railway data-corruption analysis aggregates community forum threads — directionally strong, not an incident-rate statistic. Stripe integration details (tax, invoicing, EU VAT) are deliberately out of scope until O5 is scheduled. Finally, this document assumes the cloud record lands in the *same* Railway Postgres as the team store; if that changes, the team store remains the tenancy anchor and the record references it. Parts A and B, and the vendor prose throughout, are preserved as researched on 2026-07-04 — they describe other companies' products (whose containers really are called organizations and workspaces) and our own superseded reasoning; only the Zeros-facing model was rewritten for the 2026-07-25 rename.

## Recommendations (immediate)

1. Approve the three decision-register updates above (one founder yes/no each).
2. Start O0+O1 now — they de-risk Phase 4 and unblock the Administration settings area; nothing in them waits on cloud workspaces.
3. Turn on the Supabase **Pro** plan for the auth project and switch the project to **asymmetric signing keys** (one-time toggle) so the JWKS flow is live before O0 lands.
4. When O0 provisions Railway: Pro plan, PITR on, pinned Postgres image, nightly R2 dump — before the first real row, not after.

---

## Security audit — 2026-07-04 (O0–O4)

A three-front adversarial audit (backend / app / engine, parallel agents + a cross-verifying pass) ran after O0–O4 shipped. Every finding below was verified against the actual code and **fixed in the same session** unless marked *accepted*.

*Identifiers are shown in their current, post-rename form (`teams`, `team_members`, `team.setContext`, `clearTeamContext`). At audit time they carried the `org*` names; migration 0006 renamed them on 2026-07-25 without changing any of the behavior described here.*

**Fixed — backend:**
- **Last-owner race (critical).** `assertNotLastOwner` counted owners unlocked while the callers' `FOR UPDATE` locked only the *target* row — two owners leaving concurrently could both pass and leave the team with zero owners. Now serializes on the team row (`SELECT … FROM teams WHERE id=$1 FOR UPDATE`); covered by a concurrent-departure integration test.
- **Admin could remove an owner (high).** The role-change path blocked it; the delete path only checked last-owner. Removing an owner is now owner-only (self-leave still allowed), mirroring role-change.
- **No body-size limit (med).** `hono/body-limit` at 256 KB, before the JSON parse.
- **Unverified email accepted (med).** Auth now rejects a token with `email_verified === false` (the invite accept-flow binds on email as the sole anti-takeover control).
- **Slug race (low).** Team creation retries with `ON CONFLICT (slug) DO NOTHING` and a fresh random suffix rather than check-then-insert. (The auto-created personal container this finding also covered was itself retired on 2026-07-22.)
- **No rate limiting (low, Part F).** In-memory fixed-window limiter on invite-create (20/10min), invite-accept (30/10min), and — at the time — secret-resolve (60/5min); the last one left with the vault on 2026-07-22.
- **Completeness:** added the then-missing sub-team rename and sub-team-membership routes. *Both were deleted on 2026-07-25 along with the sub-team concept; the surviving `PATCH /v1/teams/:team` is the tenant root's own rename.*

**Fixed — engine (the important one):**
- **The team layer could reroute a member's credential traffic (med).** Team secrets injected `ANTHROPIC_BASE_URL` / `HTTP_PROXY` / `NODE_EXTRA_CA_CERTS`-class names (only code-injection was filtered), and the layer was in `CREDENTIAL_REDIRECT_TRUSTED_LAYERS` — so a cloud team (a *different party* from the machine owner, unlike `managed`) could point a member's agent at a team-controlled host, carrying the member's real keychain API key. **Fix:** the layer was removed from the credential-redirect trusted set, and team *secrets* dropped credential-redirect names too. A vault holds credentials the agent *consumes* (API keys, MCP tokens — secret-shaped, still allowed); routing/proxy vars must come from the member's own `user`/`managed` config. This also makes the pre-existing `providers` user-only drop for the team layer meaningful. *The trusted-set exclusion is still live and load-bearing (see Part I); the vault half became moot when secrets were removed on 2026-07-22.*

**Fixed — app:**
- **Sign-out didn't clear engine secrets (high).** `clearTeamContext` had no production caller; decrypted team secrets lingered in engine memory across accounts. Team-sync now couriers an empty context whenever the session is not authenticated.
- **Engine always got `teams[0]` (high).** The panel's team switcher was local-only React state the sync ignored, so a multi-team user could edit team B's vault while team A's secrets stayed injected. Selection now lives in a shared, persisted `active-team` slot that drives both the panel and the sync.
- **Stale-write sync race (med).** A slow fetch could overwrite a newer one, re-injecting a just-deleted secret. Syncs are now monotonically sequenced; only the latest result is couriered.
- **Web build decrypted secrets pointlessly (med).** The sync ran on the web/relay renderer, pulling plaintext secrets into browser memory for an op the engine rejects. Now gated to a local (Electron) bridge.
- **Invite deep link lost while signed out (med).** The listener lived below the AuthGate; a cold-launch invite was dropped. The capture now sits above the gate.
- **Stale role after self-demote (med).** A self-affecting membership change now refetches the top-level role; invitations load independently so a 403 can't strand the panel on "Loading members…".
- **Deep-link log leak + token bleed (low).** The raw URL is redacted from the first `?`/`#` on parse-failure; the pending invite token is cleared on sign-out; the https invite matcher is pinned to `app.zeros.build` (host-pinning test added).

**Accepted risks (documented, not defects):**
- **Any team member can call `secrets/resolve` and get plaintext (member+, Part F).** This was by design and added no exposure: a member's own agent spawns with those secrets in its env anyway, so they can already read them. Restricting resolve to admins would have broken the engine, which runs as the member. Rate-limited as abuse control. *Moot since 2026-07-22 — the endpoint no longer exists.*
- **Team doc `[env]` values with non-secret-shaped names are visible to a member's paired devices via `settings.resolve`.** Same behavior as every other layer's `[env]`; the *vault secrets* never entered the resolve tree (spawn-only), so no secret value leaks. Only the team's documented, non-secret baseline env is exposed, and only to the member's own paired devices. *Still current — this is now the team layer's entire env surface.*
- **RLS is staged, not active.** Policies ship in `0002_rls.sql` but bind only once the service connects as a non-owner `zeros_app` role (an ops step in the runbook). Until then the app-layer `requireRole` spine is the enforcement — which the fixes above harden. RLS remains defense-in-depth, matching most production SaaS. *No longer accepted: `0004_rls_enforce.sql` created the NOLOGIN/NOBYPASSRLS `zeros_app` role, added FORCE ROW LEVEL SECURITY, and every request now enters through `SET LOCAL ROLE zeros_app`, so the policies bind for real (Part E). `0006` carried them across the rename — table renames preserve OIDs, so the grants and FORCE flag survived; only the RLS helper function had to be recreated.*

## Bibliography

[1] Linear. "Workspaces." linear.app/docs/workspaces (retrieved 2026-07-04)
[2] Linear. "Members and roles." linear.app/docs/members-roles (retrieved 2026-07-04)
[3] Linear. "Teams" + Pricing. linear.app/docs/teams · linear.app/pricing (retrieved 2026-07-04)
[4] Figma Learn. "Get started with organizations." help.figma.com/hc/en-us/articles/360039957374 (retrieved 2026-07-04)
[5] Figma Learn. "Manage seats in Figma." help.figma.com/hc/en-us/articles/360039960434 (retrieved 2026-07-04)
[6] Figma Learn. "Team permissions" + "Admins in Figma." help.figma.com/hc/en-us/articles/360039970673 · /4420557724439 (retrieved 2026-07-04)
[7] OpenAI Help. "How can I change my default organization?" help.openai.com/en/articles/4936844 (retrieved 2026-07-04; page 403'd on fetch — cited from search index)
[8] OpenAI Help. "Managing projects in the API platform." help.openai.com/en/articles/9186755 (retrieved 2026-07-04)
[9] OpenAI Help. "Managing members, seat types, and roles in ChatGPT Business." help.openai.com/en/articles/8542216 (retrieved 2026-07-04)
[10] Anthropic Help. "Creating and managing Workspaces in the Claude Console." support.claude.com/en/articles/9796807 (retrieved 2026-07-04)
[11] Anthropic Help. "Claude Console roles and permissions." support.anthropic.com/en/articles/10186004 (retrieved 2026-07-04)
[12] Anthropic. "Admin API." platform.claude.com/docs/en/build-with-claude/administration-api (retrieved 2026-07-04)
[13] Supabase Docs. "JWT Signing Keys" + "JSON Web Token (JWT)" + blog "Introducing JWT Signing Keys." supabase.com/docs/guides/auth/signing-keys · /auth/jwts · supabase.com/blog/jwt-signing-keys (retrieved 2026-07-04)
[14] ClickHouse Engineering. "How to architect multi-tenant SaaS on Postgres." clickhouse.com/resources/engineering/multi-tenant-saas-postgres-architecture (retrieved 2026-07-04)
[15] Oso. "RBAC best practices" + "Real-world RBAC examples." osohq.com/learn/rbac-best-practices · /learn/rbac-examples (retrieved 2026-07-04)
[16] WorkOS. "Multi-tenant permissions done right: What Slack, Notion, and Linear can teach us." workos.com/blog/multi-tenant-permissions-slack-notion-linear (retrieved 2026-07-04)
[17] OneUptime. "How to Design Multi-Tenant Schemas in PostgreSQL" (2026-01-25) + Bytebase "Multi-Tenant Database Architecture Patterns Explained." (retrieved 2026-07-04)
[18] SuperTokens. "Implementing the right email verification flow" + Supersaas.dev "Invitation flow." (retrieved 2026-07-04)
[19] Exploitr. "Authentication Security Checklist for SaaS Applications" + Descope "SaaS Authentication: Key Considerations & Best Practices." (retrieved 2026-07-04)
[20] DesignRevision. "SaaS Stripe Integration: Billing Made Simple (2026)." designrevision.com/blog/saas-stripe-integration (retrieved 2026-07-04)
[21] Stripe + community. "How To Create Per-Seat Billing With Stripe" (usegravity.app) · dev.to seat-based billing with Checkout. (retrieved 2026-07-04)
[22] Stripe. "Best practices for SaaS billing" + "Subscription pricing models." stripe.com/resources/more/best-practices-for-saas-billing (retrieved 2026-07-04)
[23] Vercel Docs. "Account Management" (Hobby teams, default team, last-owner rule). vercel.com/docs/accounts (retrieved 2026-07-04)
[24] Supabase. "Pricing" (50k MAU free / 100k Pro, $0.00325 overage; project pausing). supabase.com/pricing (retrieved 2026-07-04)
[25] Zeros internal. "Railway — Cloud DB + Backend Platform Evaluation" (cloud-workspace/research/railway.md, 2026-07-02: unmanaged template, HA 2026-03-13 experimental, PITR 2026-05-15, corruption-thread analysis) + "Decision update 2026-07-02" (cloud-workspace/research/decision-update-2026-07-02.md) + Conductor DB audit (chat, 2026-07-04: migrations #114/#115, org_id/permission_level columns).

## Methodology appendix

Researched 2026-07-04 inside the Zeros repo. Process: (1) parallel web sweep across eight angles — the four product models, multi-tenant Postgres schema design, Supabase asymmetric-JWT/JWKS verification, the default-personal-org pattern, RBAC schema design — followed by a targeted second wave (Stripe seat billing, invitation-flow security, Supabase pricing, OpenAI default-org confirmation) and primary-doc fetches (Vercel accounts; OpenAI help page 403'd and is labeled accordingly). (2) Cross-checked against Zeros' own prior research (cloud-workspace/research/railway.md, decision-update-2026-07-02.md) and the same-day forensic audit of Conductor's local SQLite (which showed org/permission pointers client-side and all org truth server-side — independently confirming the architecture recommended here). (3) Claims labeled per the pack convention; everything unlabeled in Parts D/E/I is design synthesis, not sourced fact. Roughly 25 sources consulted across ~40 pages.

