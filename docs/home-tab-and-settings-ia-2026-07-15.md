# Home Tab & Settings — Consolidation Audit, IA Proposal, and Execution Plan

**Date:** 2026-07-15 · **v2** (revised same day after founder review: Dashboard unchanged, org-only collaboration with teams deferred, repo page owns both workspaces *and* settings)
**Scope:** The Home tab (sidebar, dashboard), the whole Settings surface, and how User / Org / Repo scopes consolidate — including the repo ownership & sharing model, where each class of setting is stored (local machine vs git vs cloud DB), and the base this lays for collaborative cloud workspaces.
**Companion design proposal (visual):** `styles/Artifacts/Designs/design-home-settings-ia-2026-07-15.html`
**Research inputs:** four parallel codebase audits (shell/home, settings architecture, cloud control plane, repos/env/MCP storage) + `docs/teams.md` + `docs/settings-toml-architecture-audit-2026-06-20.md` + `docs/cloud-workspace/` pack.

> **ORG → TEAM RENAME 2026-07-25** (founder direction) — **supersedes this document in part. Read this before trusting any "org" / "team" wording below.**
>
> **The reversal, by name.** TL;DR #4 — *"Org-only collaboration for now — no team concept… Nothing in the UI says 'team' until then"* — and §3.6's *"With teams deferred, the word 'team' leaves the product vocabulary entirely"* are now **exactly backwards**. "Organization" was retired from the Zeros vocabulary; the tenant root is a **Team**, and "team" is the *only* word the product uses for it (Settings → Administration → **Team** + **Members**). What actually got retired is the **nested sub-team** concept §3.9 planned to bring back later: the `teams` / `team_members` sub-tables inside an org are **dropped**, leaving **one flat level** — a Team holds members directly.
>
> **Identifiers below are pre-rename.** `backend/migrations/0006_org_to_team.sql`: `organizations`→`teams`, `organization_members`→`team_members`, `org_settings`→`team_settings`, type `org_role`→`team_role`, every `org_id`→`team_id`, RLS helper `app_user_org_ids()`→`app_user_team_ids()`. API: `/v1/orgs/…`→`/v1/teams/…`, `/v1/me` returns `{ user, teams }`. Engine settings layer `org`→`team` (default < user < **team** < repo < repo-local < workspace-local < managed); RPC `org.setContext`→`team.setContext`. App: `src/zeros/org/*` → `src/zeros/team/*`, `organization-panel.tsx` → `team-panel.tsx`, `org-context.ts` → `team-context.ts`.
>
> **What this doc got right and shipped.** §1.8's "one word, four meanings" fix landed: the MDM `managed` layer's provenance chip **no longer says "Org"** — both `settings-ui.tsx` (`SOURCE_LABEL`) and `customize-mcp.tsx` (`LAYER_LABEL`) now say **"Managed"** — and the cloud layer that had *no label at all* gained its own **`team: "Team"`** chip. §3.6's proposed **"Organization"** chip therefore shipped as **"Team"**.
>
> Canonical model: [teams.md](teams.md).

---

## TL;DR — the direct answers

1. **Decision rule for "sidebar vs settings":** the home sidebar holds *destinations* — places where work lives (Dashboard, Repos). Settings holds *configuration* — how things behave. Repos are destinations → they live in the sidebar. MCP and Integrations are configuration → they stay in Settings.
2. **The Dashboard does not change.** Same board, same "All projects" + per-repo filter chips, same archived toggle. The rail's repo rows are *navigation* (they open repo pages); the Dashboard keeps its own filtering.
3. **The repo ownership model (v2, stated clearly):** a repo is **personal to the user** — a clone on their Mac, with no cloud presence by default. **Sharing a repo gives the org a *link*, not ownership**: a cloud registry row (org + origin URL) that makes the repo discoverable to org members. Code and access always stay with GitHub — Zeros never brokers repo permissions. Local workspaces are physically on your disk → personal; workspace *sharing* arrives with cloud workspaces, scoped to the org.
4. **Org-only collaboration for now — no team concept.** Everyone in the same org collaborates through shared repos and (later) shared cloud workspaces. Teams return later as *named subsets of org members* (a team member must already be an org member — the backend tables are already shaped this way, and it matches Linear/Figma). Nothing in the UI says "team" until then.
5. **The repo page is the hub for everything about a repo:** its workspaces **and** all its settings (Personal + Shared lenses) managed in place — two tabs, Workspaces | Settings. Repo settings leave the global Settings surface entirely; global Settings keeps only Account / Personal — this Mac / Organization.
6. **Settings re-organizes by *scope*, not by feature:** **Account** (cloud, follows you), **Personal — this Mac** (local machine), **Organization** (cloud, shared, admin-gated). The engine's 7-layer resolve chain already implements this; the UI just has to speak its language.
7. **settings.toml stops being a code view in the UI.** One "Open settings.toml" button (Reveal in Finder / Open in editor / Copy path). The file stays the agent-facing API — schema published, 3-second watcher already live-reloads external edits. The in-app raw TOML editor demotes to an "Advanced" overflow item.
8. **Storage is already right; naming is wrong.** User prefs, provider keys, and personal env vars already live on the user's machine (`~/.zeros/settings.toml` + OS keychain). Repo-shared settings already travel via git (committed `.zeros/settings.toml`). Org-shared settings + secrets already live in the cloud DB (Railway `org_settings` / `org_secrets`, couriered in-memory). What's broken is that the UI calls the committed repo file "Team", calls the MDM `managed` layer "Org", and gives the *actual* cloud org layer no label at all. Fix the language once, everywhere.

---

## v3 fine-tuning (2026-07-15, pre-H1) — decision register

Founder decisions taken after v2, binding for H1:

- **D1 — No sharing UI, at all, for now.** The UI reads every layer (provenance chips stay) but **writes only personal layers** (`user`, `repo-local`, `workspace-local`). The Personal/Shared lens toggle is dropped from H1; the per-repo Sharing block and the `org_repos` registry (old H3) are deferred. Manual sharing keeps working: a user or agent can hand-write and commit `<repo>/.zeros/settings.toml` — the engine resolves it exactly as today, hostile-clone filters included.
- **D2 — Future sharing channel: cloud DB primary, repo file opt-in.** When sharing UI returns, shared settings live in the cloud (`org_settings` per-repo scope — already built and couriered to org members in-memory today), and are **additionally materialized into the committed repo file only if the user explicitly enables "also save in repo"** (portability/CI/agents-without-cloud). Precedence note: the committed `repo` layer already outranks `org`, so an opt-in materialization is consistent with the resolve chain.
- **D3 — Environment variables are never shared.** Not via cloud, not via the sharing UI — env stays personal (user / repo-local, 🔒 keychain for secrets). Org-level secrets go through the existing write-only **secrets vault** (spawn-injected, weakest source), never through settings sharing. When D2 ships, shareable keys are a **whitelist** — `scripts`, `git`, `prompts`, http `mcp` — not "everything in repo settings."
- **D4 — H1 build scope (now):** home rail (Dashboard · REPOS · Add repo · profile card with gear), repo page with **Workspaces | Settings** tabs (Settings tab = relocated drill-in, personal-lens editing only), global Settings loses the repo sections (deep links redirect), Dashboard gets **zero edits**. Org switcher in the rail moves out of H1 (no org UI in the rail until sharing returns).

> **REPO PAGE REVAMP 2026-07-16** (founder direction across two review rounds, supersedes the §3.4 two-tab layout): the repo page is now a **centered column** — the repo's logo + name on top, **one segmented toggle** below it (Workspaces · Environment · Git · Scripts · Run actions · Actions · Paths), the active view's content underneath. The Workspaces | Settings tabs, the inner section nav, and the per-page details sidebar (a first-round iteration) are all gone; **Paths is a toggle view again** and carries identity / workspaces-path / Remove repository. **MCP is removed from the repo page UI only** (repo-scoped MCP still resolves from the settings files; managing it moves to the MCP surface). The header keeps exactly one action, top right: **Edit settings.local.toml** (the raw-TOML escape hatch, replacing the New-workspace button — creation lives in the top bar's `+`); the per-section "Personal — saved to …" caption line is removed. The per-repo **kanban is replaced by a day-grouped list** (Today / Yesterday / N days ago / Last 30 days / month). Deep links remap: `mcp` → the default settings view (Environment); the legacy `repo-page:tab`/`repo-page:section` hand-off keys are read once as a fallback for the new `repo-page:view` key. Dashboard still untouched (E18).
>
> **REPO-FILE SLIMMING 2026-07-17** (founder direction, amends the two paragraphs above): repo-scoped settings files (`<repo>/.zeros/settings.toml`, `settings.local.toml`, a worktree's own local file) now carry **scripts config first and foremost** — `[scripts]` setup / archive / `[[scripts.run_actions]]` — plus the `git` and `prompts` tables the Git and Actions tabs still edit, and repo-local's `workspaces.path` (Paths tab). Everything else was un-wired: **`mcp` no longer resolves from repo layers at all** (user-level MCP only; the per-repo MCP gateways, the committed-repo stdio RCE gate, and the repo MCP editor/bridge scope params were all deleted), and `env` / `env_files` / `file_include_globs` are dropped from repo layers by the sanitizer with a warning (env is Keychain-vault-only; worktree seeding uses `.worktreeinclude`). No migration — stale keys stay inert on disk. The published repo JSON schema is slimmed to match. The header button is now **Open settings.local.toml** — it seeds the file if missing and reveals it in Finder; the in-app raw-TOML editor left the repo page (the user-scope one in Settings survives).
>
> **H1 SHIPPED 2026-07-15** (branch `iamarunrk/monterrey`): new `repo` page state (`OPEN_REPO_PAGE` action + persisted `activeRepoId` with a pair-invariant on read), reworked `home-sidebar.tsx` (REPOS list with live workspace counts + Add-repo menu + profile card), new `src/zeros/panels/repo-page.tsx` (board scoped per repo, Settings tab hosting `RepoDetail` with `layer="repo-local"` fixed + the raw local-file escape hatch, `requestRepoPageView` hand-off for deep links), settings-page repo drill-in removed with legacy `repo:<id>:<section>` redirect, setup-tab/run-control deep links re-routed, top-bar "Repository Settings" context item enabled, Home button lit for the repo page. Typecheck green, 2263 tests green (+4 new persist tests), production build green, `dashboard-page.tsx` untouched (E18). Follow-ups: a ⌘, accelerator does not exist yet (gear is the entry point); the repo board card intentionally omits the Dashboard card's primary-action state machine.

---

## Part 1 — What exists today (audit)

### 1.1 Shell & Home tab

- Navigation is **not a router** — a single `activePage: "workspace" | "settings" | "dashboard"` field in the Zustand store (`src/zeros/store/store.tsx:88`, reducer `SET_ACTIVE_PAGE` in `workspace-store.ts:403`, persisted with legacy migrations in `persist-ui-state.ts`).
- `MainShellBody` (`src/app-shell.tsx:896-1025`) switches the whole layout: `isHome` (dashboard|settings) renders `HomeSidebar` + page; otherwise the two-column workspace body.
- **`src/shell/home-sidebar.tsx` is 76 lines with exactly two items** (Dashboard, Settings). Its row class is a hand-copied duplicate of the settings sidebar's (`HOME_ENTRY_CLS` ↔ `SIDEBAR_ENTRY_CLS`) — the file's own comments call it a growth seam.
- The global top bar (`src/shell/top-bar.tsx`, 1248 lines) owns: Home button, `ProjectPicker` (repo dropdown + icon chip), the synthetic **Local main** checkout tab, the scrollable workspace tab strip, `+` new workspace, and the archived-workspace picker.
- **Dashboard** (`src/zeros/panels/dashboard-page.tsx`) is a cross-repo kanban over `LIFECYCLE_STATUSES` (Backlog / In progress / In review / Done / Cancelled + Archived toggle), filtered by per-repo chips ("All projects" + one chip per project). Data: `useProjects()` (localStorage `projects-v1`) + `workspaceList` over the engine bridge. **v2: this page stays exactly as it is.**
- A shadcn-style `sidebar.tsx` primitive exists but is dead code since Column 1 was deleted (#175); both live rails are hand-rolled.

### 1.2 Settings UI

- One page: `src/zeros/panels/settings-page.tsx` (1785 lines), Linear-style sidebar + detail, selection persisted as one string (`settings:active-section`, `user:<id>` or `repo:<projectId>:<section>`).
- Current nav: **Personal** (Preferences ⟨empty placeholder⟩, Appearance, Experimental, Profile, Integrations) · **Agents** (Models, Agent providers, Terminal Agents ⟨flag-gated⟩) · **Workspace** (Repos, Environment, Git ⟨placeholder⟩, MCP) · **Administration** (Organization) · **Your Repos** (one drill-in entry per repo).
- The **"Workspace" group is mislabeled** — its Environment and MCP sections edit the *user* layer (`~/.zeros/settings.toml`), not anything workspace-scoped.
- Repo drill-in: `ReposListPage → RepoOverviewPage → RepoDetail` with sections MCP / Environment / Git / Scripts / Run actions / Actions / Paths (`REPO_SECTIONS`, `repositories-panel.tsx:125`), a **You/Team lens** picking repo-local vs committed repo layer, and per-leaf inheritance UI (`SourceTag`, `InheritedGroup`, Override/Reset). **v2: these section components move to the repo page's Settings tab — the components survive, the location changes.**
- **"Edit settings.toml"** does *not* open an external editor — it flips the page into an in-app Shiki-highlighted raw TOML editor (`RawTomlEditor`, `repositories-panel.tsx:290-354`), reading/writing the active layer file over the bridge (raw writes desktop-only).

### 1.3 The engine settings layers (the real machinery)

Precedence, weakest → strongest (`src/engine/settings/resolve.ts`):

```
default < user < org < repo < repo-local < workspace-local < managed
```

| Layer | Where | Shared with | Written by |
|---|---|---|---|
| `user` | `~/.zeros/settings.toml` (dev: `~/.zeros-dev/`) | nobody — this Mac | app UI, agents, hand-edit |
| `org` | **cloud** `org_settings.doc` — in-memory only, never on disk | every org member | Organization settings (cloud) |
| `repo` | `<repo>/.zeros/settings.toml` — **committed** | everyone who clones | app "Team" lens today |
| `repo-local` | `<repo>/.zeros/settings.local.toml` — gitignored | nobody — this Mac | app "You" lens today |
| `workspace-local` | `<worktree>/.zeros/settings.local.toml` | one worktree | MCP editor only today |
| `managed` | `~/.zeros/settings.managed.toml` — read-only | MDM / IT policy | out-of-band |

- Zod schema (`schema.ts`) with `USER_ONLY_KEYS` = `models`, `workspaces`, `tool_approvals_enabled`, `providers` — dropped from repo layers. Per-leaf sanitize, per-leaf provenance, format-preserving atomic writes, published JSON schemas for editor autocomplete, 3-second stat-poll watcher broadcasting `DB_CHANGED`.
- Spawn security is layer-aware (`spawn-env.ts` + `env-names.ts`): code-injection and secret-shaped env names dropped everywhere; credential-redirect names (base URLs, proxies) honored only from machine-owner layers, dropped from committed `repo` and cloud `org`.

### 1.4 Cloud control plane (orgs, members — already built; teams backend-only)

- **Railway Postgres + Hono service** (`backend/`), Auth0 JWTs (JWKS-verified; the Supabase wording in older comments is legacy — Auth0 is the live issuer; Supabase retains only `profiles` + `handoff_tickets`).
- Tables (`backend/migrations/0001_init.sql`): `users` (JIT-mirrored), `organizations` (`is_personal` auto-org), `organization_members` (owner/admin/member), `teams` + `team_members` (**backend-only; the UI will not surface them — see §3.9**), `invitations` (hashed tokens), `org_settings` (`scope: '*' | repo-slug`, jsonb doc — the engine's `org` layer), `org_secrets` (envelope-encrypted vault), `audit_log`, `billing_customers` + `billing_subscriptions` (**schema only — no webhook handler, no billing UI yet**).
- App side: `src/zeros/org/control-plane.ts` (typed client), `organization-panel.tsx` (overview/rename, members+roles, invites, write-only secrets vault, join-org), `org-sync.ts` (courier: fetch doc + decrypted secrets → engine in-memory `org-context.ts`; triggers = connect, sign-in/out, org switch, **15-minute poll**, explicit resync).
- Last-owner protection, default-team protection, enumeration-safe invites, RLS enforced (`0004_rls_enforce.sql`) — the O0–O4 plan from `docs/teams.md` is shipped and security-audited.

### 1.5 Repos & workspaces model

- **Project** (a repo opened in Zeros): `{id, name, repoRoot, repoSlug, originUrl, addedAt}` in localStorage `projects-v1`, written through to the canonical engine `repos` table (`src/engine/db/projects.ts`, deterministic `proj_<sha1(realpath)>`).
- **Workspace** (a worktree): engine-owned rows with the five lifecycle statuses; **Local main** is a synthetic always-first tab per repo. Hierarchy: Project → Workspaces → Chats.
- There is **no cloud registry of repos** — the repo list is per-machine. Nothing today lets an org member see "the repos our org collaborates on."

### 1.6 MCP & integrations

- MCP registry lives in the layered TOML (`[[mcp.servers]]`, any layer), resolved per-worktree with first-wins dedup, fanned into Claude/Codex/Cursor adapters by the `AgentGateway`. stdio servers from the *committed* repo layer are dropped (clone-RCE gate). OAuth via in-engine gateway; tokens in `safeStorage` (`mcp_oauth_vault`). Import wizard scans Cursor/Claude/Codex/Factory configs.
- **Integrations = GitHub only** (gh CLI / PAT / device-flow OAuth; token couriered main→engine; renderer never sees it). GitLab/Bitbucket appear only in URL slug-parsing and research docs — no auth, no API, no PR support.

### 1.7 Where secrets actually live

| Secret | Store |
|---|---|
| Provider API keys (Anthropic/OpenAI/Cursor/Factory) | `safeStorage` → `<userData>/secrets.json`, renderer-allowlisted accounts |
| Personal env-var secrets (🔒 rows) | keychain `env::<NAME>`; TOML holds sentinel `${zeros.secret}` |
| MCP env secrets / OAuth tokens | keychain `mcp::<NAME>` / `mcp_oauth_vault` (main-only) |
| GitHub token | main-process-only; couriered straight to the engine |
| Auth0 session (access+refresh) | main-process keychain `auth-session:tokens`; refresh token never enters the renderer |
| Org shared secrets | cloud vault (`org_secrets`, AES-256-GCM envelope); decrypted per-sync, engine memory only, injected weakest at spawn |

**No secret value is ever written to any settings.toml.** This invariant holds everywhere and must survive the redesign.

### 1.8 The core problem: one word, four meanings

| Term in the UI | What it actually means | Where |
|---|---|---|
| "Team" (You/Team toggle) | the **committed repo file** `.zeros/settings.toml` | `settings-page.tsx` `YouTeamToggle` |
| "Team" (Organization panel) | a **cloud group of members** inside the org | `organization-panel.tsx` |
| "Org" (`SourceTag`) | the **`managed` MDM file** on disk | `settings-ui.tsx:197-204` |
| "Organization" (nav) | the **cloud control plane** org | Administration group |
| *(no label at all)* | the **real cloud `org` settings layer** | invisible in provenance |
| "Workspace" (nav group) | sections that edit the **user** layer | settings sidebar |
| "This Mac" | the repo-local layer (but the *user* layer is also this-Mac…) | `LAYER_META` |

Three separate label maps must be kept in sync by hand today: `SOURCE_LABEL` (settings-ui), `LAYER_LABEL` (mcp-panel), `LAYER_META` (repositories-panel). This is the consolidation target. **v2 note:** dropping the team concept makes this cleanup *easier* — "Team" disappears from the vocabulary entirely; "Shared" (git) and "Organization" (cloud) carry the meaning.

---

## Part 2 — Problems (numbered)

- **P1 — The home sidebar is an empty shell.** Two rows, while the highest-traffic destinations (repos) hide two levels deep inside Settings ("Your Repos").
- **P2 — Settings groups by feature and lies about scope.** "Workspace → Environment/MCP" edits the user layer; "Personal" and "Workspace" don't map to any layer boundary.
- **P3 — Scope vocabulary collides** (§1.8). Users cannot form a correct mental model of "who else sees this setting."
- **P4 — The cloud org layer is invisible** — a value set by an org admin shows no provenance chip at all, and org-layer values can silently override user-layer ones (`user < org`).
- **P5 — settings.toml-as-code sits in the primary UI.** The founder's read is right: humans act in the UI; the file is for agents and power users. The current button label ("Edit settings.toml") also changes meaning depending on the active layer.
- **P6 — No cloud registry of repos** — "the repos our org collaborates on" cannot exist yet; every machine hand-assembles its own list.
- **P7 — Dead/placeholder surfaces confuse the map**: Preferences (empty), user-scope Git (placeholder), richer `git` schema keys unsurfaced, billing schema with no UI, dead `sidebar.tsx` primitive, legacy `repo-settings:<id>` localStorage stub.
- **P8 — Settings entry point is a nav row, not identity-anchored.** No profile/plan surface anywhere on Home (the founder's Figma reference: profile bottom-left, settings behind it).
- **P9 — Repo settings are trapped inside global Settings, split from the repo's workspaces.** Everything about one repo — its workspaces *and* its settings — should be managed in one place: the repo's own page.
- **P10 — Teams exist in the backend but have no product meaning.** **v2 resolution: keep them backend-only and defer the concept entirely — org-only collaboration for now** (see §3.9).

---

## Part 3 — The proposal

### 3.1 The decision rule (answers "what goes in the sidebar vs settings")

> **Sidebar = destinations. Settings = configuration.**
> A thing goes in the home sidebar iff you *go there to work* (the board, repos). A thing goes in Settings iff you *adjust it and leave* (appearance, keys, MCP servers, integrations, members, billing). MCP and Integrations are configuration → Settings. Repos are destinations → sidebar. A repo's *own* settings are part of the repo destination → the repo page.

### 3.2 Home tab

```
┌────────────────────────────────────────────────────────────┐
│ ⬤⬤⬤  ⌂  [Okit ⌄]  💻 main │ tab │ tab │ +                 │  ← top bar (unchanged)
├──────────────┬─────────────────────────────────────────────┤
│ [Arun's Org ▾]                                             │  ← org switcher (quiet for solo users)
│              │                                             │
│ ▦ Dashboard  │        Dashboard — UNCHANGED                │
│              │   [All projects] [Okit] [website]  chips    │
│ REPOS        │   Backlog │ In progress │ In review │ …     │
│ ◩ Okit       │                                             │
│ ◪ website    │                                             │
│ ▣ api-server ⇅ (shared · Acme — not cloned yet)            │
│ + Add repo   │                                             │
│              │                                             │
├──────────────┤                                             │
│ Ⓐ Arun Raj ⚙ │                                             │  ← profile card: name · plan · gear → Settings
└──────────────┴─────────────────────────────────────────────┘
```

- **Dashboard — no changes.** The board, the "All projects" + per-repo chips, the Archived toggle: all exactly as today. The rail's repo rows *navigate* to repo pages; the Dashboard keeps its own chip filtering. Two different jobs, no conflict.
- **Org switcher (top).** Shows the active org (`org:active-id` already exists). For a solo user on their personal org it renders as a quiet label — no enterprise chrome.
- **REPOS section — one flat list of all repos** (the founder's ask: "we will list all the repos in the repos section"). Three row states:
  1. **Personal repo** — plain row (icon, name, workspace count). Local-only, no cloud presence.
  2. **Shared repo you have locally** — same row + a small shared badge (org glyph). Everything works as personal; the badge just says "org members can see this repo exists."
  3. **Shared repo you *don't* have locally** — dimmed row with a Clone affordance; clicking opens the clone page (uses *your* GitHub auth).
  Click → repo page (§3.4). Right-click → existing context menu (Change icon, Remove, Repository Settings → repo page Settings tab).
- **No TEAMS section.** Org-only (§3.9). The rail never says "team."
- **Profile card (bottom).** Avatar initials, display name, plan label (org name until billing ships), gear → Settings. Replaces the "Settings" nav row; ⌘, still works; deep links preserved.

### 3.3 The ownership model — stated clearly (v2)

The founder's question: *"the repo doesn't belong to the org or teams… repo is personal to the user, but shared — how does it work? Tell me clearly."* Here is the model, three layers:

**1. GitHub (later GitLab/Bitbucket) owns the code and the access.** Who may read or push a repo is decided by the git host, never by Zeros. Zeros never proxies repo credentials; every member uses their own GitHub auth (Integrations).

**2. The user owns their copy.** "A repo in Zeros" = a clone on your Mac, registered in your local projects list (+ engine `repos` table). Personal by default: **no cloud row exists at all.** Your workspaces are worktrees on your disk — physically personal. Removing a repo touches only your machine.

**3. The org gets a *link*, never ownership.** Sharing a repo into the org creates one cloud registry row:

```
org_repos { id, org_id, origin_url (normalized, unique per org),
            name, default_branch, icon, shared_by, created_at }
```

That row does exactly two things: (a) makes the repo **discoverable** — it appears in every org member's REPOS section; (b) becomes the **anchor** that shared settings scopes (`org_settings` per-repo scope, `org_secrets` per-repo scope) and, later, shared cloud workspaces attach to. It does **not** move code, grant access, or transfer ownership. Unsharing deletes the row; everyone's local clones are untouched.

**What is shared, at each stage:**

| Stage | Shared across the org | Still personal |
|---|---|---|
| **Now (H1–H4)** | Repo *discovery* (the registry row) · repo Shared settings (committed `.zeros/settings.toml` — travels via git anyway) · org settings doc + secrets vault (already live) | Your clone, your worktrees/workspaces, your Personal settings, your keys |
| **Cloud workspaces (Phase 8)** | **Workspaces become shareable**: a cloud workspace runs in a sandbox, carries the org context, and org members can open/join it (live engine + cloud record; membership rows in the registry) | Local workspaces — their engine runs on your Mac. (The local write-through fast-follow syncs their *history to your own account*, still not to other people) |

**Who sees what:** an org member sees the *name and origin* of every shared repo (the registry row) — but its files only if GitHub lets them clone it, and its workspaces only when cloud workspaces ship and one is shared. A repo shared into the org but private on GitHub shows the "ask an admin on GitHub" state when a member without access tries to clone.

### 3.4 The repo page — workspaces AND settings, managed in place (v2)

The founder's requirement: *"I not only manage the workspaces, but also its settings (user and team) — every repo settings, workspace will be managed there."*

The repo page gets **two tabs**:

- **Workspaces** — the repo's board (same board components as the Dashboard, scoped to this repo), `+ New workspace`, recent activity. This is where shared cloud workspaces will list later.
- **Settings** — the *entire* existing repo drill-in, relocated here: MCP · Environment · Git · Scripts · Run actions · Actions · Paths (`REPO_SECTIONS` components survive unchanged), with — **as amended by v3 D1**:
  - **personal-lens editing only**: the UI writes `.zeros/settings.local.toml` (gitignored, only you). No toggle writes the committed file; values inherited from the committed **Shared** layer, the **Organization** layer, or **Managed** render read-only with their provenance chips (§3.6);
  - per-leaf provenance chips including the **Organization** chip where an org-layer value applies to this repo;
  - **Open settings.toml ▾** (both files listed — the personal local file for editing, the committed file for inspection/manual sharing);
  - ~~a Sharing block~~ — deferred with the registry (v3 D1);
  - the **Danger zone**: Remove repository (existing behavior).

Global Settings loses all repo content: no "Repos" section, no "Your Repos" list. The old deep links (`repo:<projectId>:<section>`) keep resolving — they now open the repo page's Settings tab at that section.

### 3.5 Settings — scope-first IA (global settings only)

| New group | Sections | Scope / storage |
|---|---|---|
| **Account** *(cloud — follows you)* | Profile (identity, sign-in methods, sign-out, usage data) | Auth0 + Supabase `profiles` |
| **Personal — this Mac** *(local)* | Preferences *(only when it has content)* · Appearance · Experimental · Models · Agent providers (keys) · Environment · MCP · Integrations (GitHub) · Terminal agents | `~/.zeros/settings.toml` + keychain + localStorage |
| **Organization** *(cloud — shared, admin-gated)* | Overview · Members & invites · Shared repos (the registry list; unshare/rename) · Shared settings (the org layer doc, org-wide + per-repo scopes) · Secrets vault · Billing *(when O5 ships)* · Audit *(later)* | Railway `org_settings` / `org_secrets` / `org_repos` / membership tables |
| *(gone)* | Repos / "Your Repos" | → repo pages (§3.4); drill-in components and deep-link IDs preserved |

Notes:

- "Workspace" as a group name dies — Environment and MCP move under **Personal — this Mac** where they truthfully belong; their repo-scoped twins live in each repo page's Settings tab.
- The user-scope **Git placeholder** is cut until the unsurfaced `git` schema keys (`branch_prefix_type`, `delete_branch_on_archive`, `archive_on_merge`) get a real panel.
- **No Teams section anywhere.** The Organization group gains **Shared repos** — the admin view of the registry (list, who shared, unshare) complementing the per-repo Sharing block.
- Settings becomes a full-page surface with its own sidebar and "← Back", killing the double rail.

### 3.6 One scope language (rename once, everywhere)

Single source of truth — one exported `LAYER_LABEL` map replacing the three divergent copies:

| Layer | Today | **Proposed chip** | Hint text |
|---|---|---|---|
| `default` | Default | **Default** | Built-in fallback |
| `user` | User | **Personal** | Only you, this Mac |
| `org` | *(none!)* | **Organization** | Everyone in ⟨org⟩, from the cloud |
| `repo` | Repo / "Team" | **Shared** | Committed with the repo — everyone who clones |
| `repo-local` | This Mac / "You" | **Personal · this repo** | Only you, gitignored |
| `workspace-local` | This Workspace | **This workspace** | One worktree only |
| `managed` | Org | **Managed** | Set by your IT policy, read-only |

- The **You/Team toggle → "Personal / Shared"**. With teams deferred, the word "team" leaves the product vocabulary entirely — no collision left to have.
- Every provenance chip gains a hover explaining *who else sees this* — the question users are actually asking.

### 3.7 settings.toml — file, not page

- Header button becomes **"Open settings.toml ▾"**: Reveal in Finder · Open in editor (`$EDITOR`/OS default) · Copy path. Per-scope: user file, repo committed file, repo-local file (labeled with the §3.6 names).
- The 3-second watcher already makes external edits live — say so in the menu ("changes apply automatically").
- The in-app `RawTomlEditor` demotes to an overflow "Edit raw (advanced)" item in the first release, with removal as the target once external-open proves sufficient. Raw writes stay desktop-only either way.
- The file remains the **agent-facing API**: published JSON schemas, format-preserving writes, comments preserved. Nothing about the engine changes.

### 3.8 Storage & sync model

Already true today, kept and named:

| Class | Lives | Sync channel |
|---|---|---|
| User preferences, models, provider auth prefs | `~/.zeros/settings.toml` + localStorage mirror | none — per machine |
| User API keys, env secrets, MCP tokens | OS keychain (`safeStorage`) | none — never leaves the machine |
| Repo shared config (scripts, git, env names, MCP, prompts) | committed `.zeros/settings.toml` | **git** — travels with clones/branches |
| Personal per-repo overrides | `.zeros/settings.local.toml` (gitignored) | none |
| Org shared settings doc | cloud `org_settings` (jsonb, `'*'`/repo scopes) | control-plane fetch → in-memory courier (15-min poll + resync) |
| Org shared secrets | cloud `org_secrets` (envelope-encrypted) | decrypted per-sync, engine memory only, weakest spawn source |
| Org shared-repo registry | cloud `org_repos` (new, §3.3) | control-plane fetch |

**Environment-variable scoping guidance** (surfaced as helper text in both Environment editors):

| You're setting… | Put it in | Chip |
|---|---|---|
| Your own API key / personal secret | Personal Environment with 🔒 (keychain) or Agent providers | Personal |
| A machine-specific path or tweak for one repo | repo page → Settings, Personal lens | Personal · this repo |
| A non-secret default every clone should get (e.g. `NODE_ENV`) | repo page → Settings, Shared lens | Shared |
| A secret every org member needs (service key) | Organization → Secrets vault, scoped org-wide or per-repo | Organization |

### 3.9 Org-only collaboration — and how teams return later (v2)

**Now: the org is the collaboration circle.** If two users are in the same org, they can: see the org's shared repos (registry), clone them with their own GitHub auth, inherit org shared settings + secrets (already live), and — when cloud workspaces ship — open and join shared workspaces. No smaller grouping exists. This matches the auto-personal-org design already shipped: solo users see none of this chrome; the moment a second member joins, sharing works with zero additional concepts.

**Later: teams = named subsets of org members.** When a real need appears (large orgs wanting to scope sharing narrower than "everyone"), teams come back as pure *filters*:

- A team is created inside the org from **existing org members only** — `team_members ⊆ organization_members`, enforced at the API (the backend `teams`/`team_members` tables already exist and are shaped exactly this way; this is also the Linear/Figma model).
- A shared repo (and later a shared workspace) gains an optional `team_id` narrowing: "visible to Team X" instead of "visible to the whole org." One nullable column on `org_repos`, additive migration.
- The UI stays team-free until that day; nothing built in H1–H4 has to change because teams only ever *narrow* org-wide sharing.

**Answer to the founder's direct question:** yes — team members must be org members. A team is never a parallel membership system; it's a label over the org's member list. Invite people to the *org*; group them into teams later if needed.

### 3.10 Cloud workspace readiness (the base being laid)

Per `docs/cloud-workspace/` (live engine + cloud record, Phase 8 collaboration): when collaborative workspaces arrive, they need — an org context (✅ switcher, §3.2), a shared repo container to hang workspaces off (✅ registry, §3.3), a per-repo workspace surface (✅ repo page Workspaces tab), identity anchoring (✅ profile card; server-stamped authorship is Phase 8 backend), and membership-gated settings (✅ Organization group). The additions then are *rows and chips, not rearchitecture*: shared-workspace rows on the repo page, presence avatars, "Invite to workspace," and the cloud-record history view. Sharing scope at launch = the org (§3.9); team narrowing slots in later without moving anything.

---

## Part 4 — Edge cases & use cases

| # | Case | Behavior |
|---|---|---|
| E1 | Solo user, personal org | No org chrome, no shared badges, quiet switcher, Organization settings minimal. Individuals never feel the enterprise scaffolding. |
| E2 | Offline / control plane down | Local + git-backed settings fully work; the Dashboard and repo pages work (they're local data). Shared-repo rows and Organization sections show last-fetched state + an offline banner; org layer is in-memory, so after an offline *restart* org settings/secrets are absent until reconnect — spawn proceeds without them (weakest source). |
| E3 | Multiple orgs | Rail shows the **active org's** shared repos + all personal repos. Switching org swaps shared rows and re-couriers the engine org context (`org-sync` already handles switch + sign-out clearing). |
| E4 | Repo shared by someone else, I already have it locally | Rows merge by normalized origin URL: my local row gains the shared badge. No duplicates. |
| E5 | Repo with no origin / multiple remotes | Not shareable; the Sharing block explains why. Identity falls back to path locally. Normalize the `git.remote`-selected origin for the registry. |
| E6 | Member lacks GitHub access to a shared repo | Clone fails with a directed message ("ask an admin on GitHub"); Zeros never proxies credentials. |
| E7 | Leaving / removed from org | Shared rows disappear on next sync; **local clones and worktrees remain** (user's disk, user's data); org layer + secrets cleared from engine memory (already implemented on sign-out; reuse for membership loss). |
| E8 | Hostile committed repo settings | Unchanged, already enforced: stdio MCP dropped from the committed layer, credential-redirect env names dropped from repo + org layers, `USER_ONLY_KEYS` stripped. Renames must not touch enforcement. |
| E9 | Org admin sets a value the user also set | `user < org` — org wins; the field shows chip **Organization** with "who set this" hover and an Override affordance only where a stronger personal layer legitimately exists (repo-local). |
| E10 | Invite accepted mid-session | Existing deep link + `requestOrgResync()`; shared repo rows appear live (subscribe to the same resync). |
| E11 | Unshare a repo others rely on | Registry row deleted; members' rows lose the badge (cloned repos stay local rows); uncloned rows disappear. Confirm dialog states exactly this. |
| E12 | Repo renamed / re-cloned to a new path | Engine `proj_<sha1(realpath)>` changes; registry match is by origin URL, so shared identity survives; local row re-links. |
| E13 | Same repo shared in two of my orgs | Local row merges with the *active* org's badge; the other org's link is simply not shown until I switch. |
| E14 | Web / relay client | Raw TOML edit + Reveal-in-Finder are desktop-only; remote reads stay redaction-masked. Nothing new crosses the relay. |
| E15 | Dev vs prod | User layer is dev-isolated (`~/.zeros-dev`); repo layer intentionally shared; org context follows the signed-in account — unchanged, documented. |
| E16 | Deep links & migration | `settings:active-section` strings keep parsing: `user:*` → global Settings; `repo:<id>:*` → repo page Settings tab; new `org:*`. `persist-ui-state.ts` already has the legacy-migration pattern. |
| E17 | Keyboard | ⌘, → Settings; ⌘/ palette gains "Go to repo…" entries; Esc/Back leaves full-page Settings. |
| E18 | Dashboard invariant | The Dashboard renders identically before and after H1 — a screenshot diff should show only the rail changed. |

---

## Part 5 — Execution plan

Phases are additive and independently shippable. Sizes assume current codebase.

| Phase | Scope | Key work | Touch points | Size |
|---|---|---|---|---|
| **H1 — Home shell + repo pages** *(v3 scope — building now)* | Sidebar + repo hub | REPOS rail section (projects store + `RepositoryIcon`), profile card (identity, gear → settings), **repo page with Workspaces \| Settings tabs** — Workspaces = board scoped to the repo; Settings = relocated `REPO_SECTIONS` drill-in, **personal-lens editing only (D1)**; no org switcher, no sharing UI. Global Settings loses the repo sections; `repo:<id>:<section>` deep links redirect to the repo page. **Dashboard untouched (E18).** One shared rail-row style. | `home-sidebar.tsx`, `app-shell.tsx` (`MainShellBody`), `store.tsx`/`workspace-store.ts` (page state: repo selection), `settings-page.tsx` (nav cleanup + redirect), `repositories-panel.tsx` (relocation host), `persist-ui-state.ts` (migrations) | ~1–1.5 wk |
| **H2 — Settings re-IA** | Scope-first global settings + language | Regroup `SECTIONS`/`SECTION_GROUPS` (Account / Personal — this Mac / Organization), remove repo sections from global Settings (deep links → repo pages), unified `LAYER_LABEL` map + chip renames (Personal/Shared/Organization/Managed), org-layer provenance chip, "Open settings.toml ▾" menu (reveal/open/copy; watcher note), demote raw editor to Advanced, full-page settings with Back, cut Git placeholder | `settings-page.tsx`, `settings-ui.tsx`, `mcp-panel.tsx`, small main-process IPC for reveal/open-in-editor | ~1–1.5 wk |
| **H3 — Org-shared repos** *(deferred — v3 D1; needs founder go)* | Cloud repo registry | `org_repos` table + CRUD routes (control plane), per-repo Sharing block + Organization → Shared repos list, shared badges + clone-on-demand rows in the rail, origin-URL normalization, org switcher in the rail | `backend/` (1 migration + routes), `control-plane.ts`, `home-sidebar.tsx`, repo page | ~1–1.5 wk |
| **H4 — Org shared settings UI** *(deferred — v3 D2/D3: cloud-primary, whitelisted keys, env excluded, opt-in repo materialization)* | Make the org layer real in the UI | Organization → Shared settings editor over `org_settings.doc` (whitelist: scripts/git/prompts/http-MCP; **no env**), "also save in repo" opt-in, env-scoping guidance text, secrets-vault scope picker polish | `organization-panel.tsx`, `org-sync.ts` (already couriers), engine unchanged | ~1 wk |
| **H5 — Workspace-collab seams** *(rides cloud Phases 4–8)* | Reserve, don't build | Shared-workspace rows on repo pages (org-scoped), presence avatar slots, "Invite to workspace" gated off; team narrowing = one nullable `team_id` later | design only in this track | — |

Total for H1–H4: **~4.5–5.5 weeks.** H1 and H2 have zero backend dependencies and can start immediately; H3 is the first backend addition; H4 is UI over an API that already exists.

---

## Part 6 — Open questions for the founder

1. **Q1 — Settings entry redundancy:** profile-card gear only (pure Figma), or also keep a small gear row in the sidebar during the transition? *(Recommendation: gear + ⌘, only; add a first-run tooltip.)*
2. **Q2 — Raw TOML editor:** demote to Advanced (recommended) or remove outright in H2? Removal simplifies `settings-page.tsx` materially but cuts the only remote raw-edit path.
3. **Q3 — Who may share a repo into the org:** any member, or admin+? *(Recommendation: any member may share; unshare = sharer or admin — matches "repo is personal, the org gets a link".)*
4. **Q4 — Offline org cache:** accept "org layer absent after offline restart" (current), or add an encrypted on-disk cache of the org doc (not secrets)? *(Recommendation: accept for now; revisit with cloud workspaces.)*
5. **Q5 — Repo page default tab:** land on Workspaces (recommended — it's the work) with Settings one click away, or remember the last-used tab per repo?
6. **Q6 — Plan label before billing ships:** show nothing, or the org name on the profile card until `billing_subscriptions` has a UI? *(Recommendation: org name until O5.)*

---

## Appendix — file map (redesign touch points)

- **Shell:** `src/app-shell.tsx` (MainShellBody), `src/shell/home-sidebar.tsx`, `src/shell/top-bar.tsx` (+helpers), `src/zeros/store/{store.tsx,workspace-store.ts,persist-ui-state.ts,use-open-workspace.ts}`
- **Dashboard (unchanged) / repo pages:** `src/zeros/panels/dashboard-page.tsx` *(no edits)*, `src/zeros/lib/workspace-status.ts`, `src/zeros/store/{projects-store.ts,use-projects.ts,repository-icons.ts}`, `src/zeros/ui/repository-icon.tsx`
- **Settings UI:** `src/zeros/panels/{settings-page,repositories-panel,providers-panel,organization-panel,mcp-panel,github-section,run-actions-section}.tsx`, `src/zeros/settings/{settings-ui.tsx,use-settings.ts}`
- **Engine (unchanged by design):** `src/engine/settings/{schema,files,resolve,ops,org-context,spawn-env,env-names,watch}.ts`
- **Cloud:** `backend/` (routes/migrations), `src/zeros/org/{control-plane,org-sync,active-org,invite-link}.ts`
- **Docs this consolidates:** `teams.md`, `settings-toml-architecture-audit-2026-06-20.md`, `mcp-consolidated-architecture-audit-and-test-plan-2026-06-30.md`, `cloud-workspace/` pack
