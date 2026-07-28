# Zeros MCP Subsystem — Consolidated Architecture, Security Audit & Test Plan

**Date:** 2026-06-30
**Status:** ✅ **Authoritative current-state doc.** The OAuth "authenticate-once" gateway, the two-tier secret model, per-scope/per-repo servers, the import wizard, and the relay security boundary are all **shipped**. Phase 2c (Zeros' own MCP server) is the only genuinely deferred piece.
**Scope:** Everything MCP in Zeros — the unified registry in `settings.toml`, the 3-agent fan-out (Claude / Codex / Cursor), the in-engine OAuth gateway, secret custody, the import/adopt wizard, the Settings → MCP UI, and the relay (remote) security boundary.

**This document consolidates and supersedes:**
- `docs/mcp-audit-and-test-plan-2026-06-24.md` (the 9-dimension audit + user test plan)
- `docs/mcp-gateway-execution-plan-2026-06-20.md` (gateway research, architecture, OAuth flow, security list)
- `docs/mcp-secrets-and-env-unification-plan-2026-06-20.md` (the two-tier secret model, Phases A–D)
- `docs/unified-mcp-config-research-2026-06-20.md` (the Phase 0–1b foundation research: MCP protocol primer, per-agent config fragmentation, competitive landscape, and the pass-through/adopt + registry/fan-out/scopes/RCE-gate/stdio-keychain design everything here builds on) — **absorbed into Appendices A–F on 2026-07-01; this doc is now self-contained.**

**This doc is the single source of truth for MCP in Zeros:** sections 1–12 are the shipped current state, security audit, and test plan; Appendices A–F carry the foundational protocol / landscape / pass-through research and the primary sources.

**Method / freshness:** Re-audited against the live code on **2026-06-30** via a 7-dimension multi-agent pass (gateway server/safe-fetch · OAuth provider/vault · registry/schema/scopes · secret couriers · remote redaction · agent adapters · scan/import/UI), each finding re-verified with file:line evidence. **193 MCP tests pass across 16 core suites, reproduced this date.** Where the live code disagrees with the older docs, this doc + the in-code comments win — and §9 lists every drift, including **four the 06-24 audit itself missed**.

---

## Table of contents

1. [Status at a glance](#1-status-at-a-glance)
2. [Feature inventory](#2-feature-inventory)
3. [Architecture](#3-architecture)
4. [The unified secret model (two tiers)](#4-the-unified-secret-model-two-tiers)
5. [How each user-facing mechanic works](#5-how-each-user-facing-mechanic-works)
6. [OAuth flow & the security must-solve list — verified status](#6-oauth-flow--the-security-must-solve-list--verified-status)
7. [Audit findings (resolved)](#7-audit-findings-resolved)
8. [Known limitations & deferred work](#8-known-limitations--deferred-work)
9. [Drift corrected (doc ↔ code reconciliation)](#9-drift-corrected-doc--code-reconciliation)
10. [Test plan](#10-test-plan)
11. [Reference: schema, bridge ops, ports, file map](#11-reference-schema-bridge-ops-ports-file-map)
12. [History of record: phasing & resolved decisions](#12-history-of-record-phasing--resolved-decisions)

**Appendices (foundational research, absorbed 2026-07-01):**
- A. [MCP protocol primer (host / client / server; transports; auth)](#appendix-a--mcp-protocol-primer-host--client--server-transports-auth)
- B. [Per-agent native MCP config reference (the fragmentation)](#appendix-b--per-agent-native-mcp-config-reference-the-fragmentation)
- C. [Competitive landscape: nobody unifies MCP](#appendix-c--competitive-landscape-nobody-unifies-mcp)
- D. [Gateway ecosystem survey (build-vs-embed evidence)](#appendix-d--gateway-ecosystem-survey-build-vs-embed-evidence)
- E. [Pass-through & cloud-managed MCP ("don't make me reconfigure")](#appendix-e--pass-through--cloud-managed-mcp-dont-make-me-reconfigure)
- F. [Primary sources](#appendix-f--primary-sources)

---

## 1. Status at a glance

Zeros is an MCP **host**: register an external MCP server **once** and it fans out to all three agents in each one's native config shape — "configure once → all agents", plus "authenticate once" for OAuth servers via a local gateway.

| Pillar | State | One-line |
|---|---|---|
| Unified registry + layered scopes | ✅ Shipped | `[[mcp.servers]]` in layered `settings.toml`; per-layer concat, dedup first-wins |
| 3-agent fan-out (Claude/Codex/Cursor) | ✅ Shipped | Native shape per agent; secrets never on a Codex `-c` line (sentinel-stripped or gateway-brokered) |
| In-engine OAuth gateway ("auth once") | ✅ Shipped | Localhost Streamable-HTTP aggregator; OAuth 2.1 brokered once; tokens in an engine-only vault |
| `auth:"header"` static-key mode | ✅ Shipped | Static API-key header held in the gateway vault, never in settings / on a command line |
| Per-repo gateways | ✅ Shipped | Committed/repo-local OAuth/header servers get their own gateway instance (ephemeral port) |
| Tool allowlist / Cursor ~40-cap filter | ✅ Shipped | `disabled_tools` enforced (filtered) in the aggregator, not just deduped |
| Two-tier secret model | ✅ Shipped | Process-env tier (`mcp::`/`env::` keychain) + connection tier (engine-only `mcp_oauth_vault`) |
| Secret `[env]` values + User Environment UI | ✅ Shipped | Phases C+D: `env::<NAME>` keychain sentinel + a User → Environment section |
| Import / adopt wizard | ✅ Shipped | Cursor / Claude Code (incl. project-scoped) / Codex / Factory / Claude Desktop + per-repo files |
| Headless (no-browser) OAuth | ✅ Shipped | Paste-the-code flow |
| Remote (relay) boundary | ✅ Shipped + hardened | `mcp` write-denied remotely; gateway/scan ops desktop-only; header/env values masked on remote reads |
| **Zeros' own MCP server (Phase 2c)** | ⏳ Not started | Genuinely deferred — the only major unbuilt piece |

**Security posture:** 1 critical + 2 high + 7 medium + ~6 low SSRF/secret/redaction issues found in the 06-24 audit are **all fixed and test-covered**. The 06-30 re-audit found **no new exploitable bugs**, but did find **doc-vs-code drift** in the OAuth-refresh and client-identity claims (§9) — the *code* is safe; the *older docs* over-claimed.

---

## 2. Feature inventory

| Capability | Where (file) | Status |
|---|---|---|
| **Unified registry** in layered `settings.toml` (`[[mcp.servers]]`, stdio \| http) | `settings/schema.ts`, `agents/mcp-registry.ts` | ✅ |
| **Per-agent fan-out** — Claude SDK `mcpServers` (in-memory), Codex `-c mcp_servers.*` TOML, Cursor `{command\|url}` (stdin) | `agents/adapters/{claude-sdk,codex,cursor-sdk}` | ✅ |
| **Layered scope** — User (global) · repo **Shared** (committed) · **This Mac** (repo-local) · **This Workspace** (workspace-local) · managed | `mcp-registry.ts` `resolveMcpServers()` | ✅ |
| **Committed-repo stdio RCE gate** — a `command` from a committed `repo` file is dropped (host RCE on clone); http allowed | `mcp-registry.ts:240-246` | ✅ |
| **Keychain stdio env secrets** — `${zeros.secret}` sentinel in settings; value in Keychain `mcp::<NAME>`; couriered into the agent's process env | `src/zeros/agent/mcp-secrets.ts` | ✅ |
| **Secret `[env]` values** — same sentinel pattern for the global `[env]` table (`env::<NAME>`) | `src/zeros/agent/env-secrets.ts` | ✅ |
| **In-engine OAuth gateway** — localhost Streamable-HTTP aggregator; brokers OAuth 2.1 once; tokens in an engine-only vault persisted to `safeStorage` | `agents/gateway/*` | ✅ |
| **`auth:"header"` mode** — static API-key header held in the gateway vault | `gateway/server.ts` + `mcp.gateway.setHeaderSecret` | ✅ |
| **Per-repo gateways** — a repo's committed/`repo-local` OAuth/header servers get their own gateway instance | `index.ts` `repoGateways`, `agents/gateway.ts` | ✅ |
| **Tool allowlist / Cursor ~40-cap filter** — `disabled_tools` filtered out of the aggregated set | `gateway/server.ts` `connectBackends` | ✅ |
| **Import / adopt wizard** — scan Cursor / Claude Code (incl. project-scoped) / Codex / Factory / Claude Desktop + per-repo `.cursor`/`.mcp.json` | `agents/mcp-scan.ts`, `panels/mcp-import-dialog.tsx` | ✅ |
| **Headless (no-browser) OAuth** — paste-the-code flow | `gateway/server.ts` `beginAuthorize`/`completeAuthorize` | ✅ |
| **Source badges + inherited view** — shows which layer each server came from, with "Override here" | `workspace/service.ts`, `panels/mcp-panel.tsx` | ✅ |
| **Zeros' own MCP server (Phase 2c)** | — | ⏳ not started |

**Bridge ops (all gateway/scan ops are LOCAL-ONLY — never reachable from a relay device):**
`mcp.scanNative` · `mcp.resolveComposed` · `mcp.gateway.status` · `mcp.gateway.authorize` · `mcp.gateway.disconnect` · `mcp.gateway.beginAuth` · `mcp.gateway.completeAuth` · `mcp.gateway.setHeaderSecret`. Settings writes go through `settings.write`, and `mcp` is on the `REMOTE_WRITE_DENYLIST` (`["scripts","providers","env_files","mcp"]`).

---

## 3. Architecture

### 3.1 The reframe that sets the scope

**All three agents already perform the MCP OAuth 2.1 flow natively** (Claude Code: DCR + CIMD + keychain + auto-refresh; Cursor: OAuth 2.1 + PKCE; Codex: `codex mcp login`). So a gateway is **not** required for an agent to *reach* an OAuth server. What the gateway buys is the thing the user asked for:

- **Authenticate once, not 3×.** One consent + one token vault instead of three separate stores.
- **Configure once.** One localhost MCP entry per agent fronts every backend.
- **Central tool filtering + namespacing** → a clean fix for Cursor's ~40-tool cap and context bloat.
- **Safe HTTP-header secrets.** A static `Authorization` header can't ride config inheritance and **leaks on Codex's `-c` command line** — the gateway holds it instead; agents hit localhost with no secret.

The value concentrates in the *hardest* slice (OAuth brokering + token custody). The aggregator shell is the vehicle; static-header pass-through is a cheap intermediate; OAuth brokering is the payoff.

### 3.2 Build vs embed — decision: **built a thin aggregator on the official TS MCP SDK**

Rejected: MetaMCP (Postgres + Docker + Next.js), Docker MCP Gateway / MCPJungle / k8s variants (heavy infra), 1MCP (closest — a Node CLI with real two-way OAuth — but no library API and its own token store, so we'd shell out + shim its keychain anyway). Chosen: assemble on **`@modelcontextprotocol/sdk` v1** (pin v1; v2 is pre-alpha). It ships every primitive: the client-side `auth()` orchestrator + `OAuthClientProvider` interface + lower-level discovery/exchange/refresh helpers + `StreamableHTTPClientTransport`, and the server-side `StreamableHTTPServerTransport`/`Server`.

### 3.3 Runtime — **REVISED during the build: runs IN-ENGINE (bun), not a Node subprocess**

The original plan argued for a Node host subprocess on the assumption that bun breaks `node:http2`/TLS (the Cursor/PTY-host reason). The build **reversed** this: MCP Streamable-HTTP is **HTTP/1.1** (`node:http` inbound + `fetch` outbound), which never touches the `node:http2` path that breaks bun. A full server↔client roundtrip was verified under bun → the gateway runs **in-engine, fully type-checked, no `.cjs` host**.

### 3.4 The picture

```
 ┌─────────── Electron main (Node) ───────────┐     OS Keychain (safeStorage)
 │  safeStorage  ◄── token custody (durable) ──┼──────────┐
 │   account: mcp_oauth_vault (main-only)       │          │  account: mcp::<NAME>,
 └──────┬───────────────────────────────────────┘          │           env::<NAME> (renderer-allowlisted)
        │  restore via engine STDIN (host.mcpVault)         │
        │  persist via control fd 3 (ZEROS_CONTROL_FD)      │
 ┌──────┼──────── engine (bun) ─────────────────────────────┼────────┐
 │  in-engine OAuth vault (resource-URI keyed, in-memory)    │        │
 │  ┌────────────────── Gateway (in-engine) ─────────────────▼─────┐  │
 │  │  MCP SERVER  (Streamable HTTP, 127.0.0.1:<gwPort>/mcp)        │  │
 │  │     ▲  loopback-only + Host/Origin DNS-rebind guard (403)    │  │
 │  │     │  tools/list = union of backends, `server__tool` ns      │  │
 │  │  MCP CLIENT  → backend A (OAuth)  → backend B (header) …      │  │
 │  │     └─ per-backend OAuthClientProvider + safe-fetch (SSRF)    │  │
 │  └────────────────────────────────────────────────────────────────┘ │
 │  resolveMcpServers() partitions: direct servers vs gateway backends  │
 │  (auth:"oauth"|"header") → injects ONE http entry per agent          │
 │  Claude (in-memory) / Codex (-c TOML) / Cursor (stdin) adapters      │
 └──────────────────────────────────────────────────────────────────────┘
        browser flow: gateway → host → shell.openExternal
        loopback callback: gateway listens 127.0.0.1:<callbackPort>/callback
```

- **Outward (to agents):** one Streamable-HTTP MCP server bound to **127.0.0.1 only**. The **user/global gateway uses fixed ports** (engine base + 8 → `24201` Stable / `24211` Beta / `24301` Dev, callback base + 9 → `24202` / `24212` / `24302`). **Per-repo gateways use ephemeral ports (`:0`)** and advertise the OS-assigned port back. No bearer on the endpoint (localhost-only + token-holding ⇒ never exposed beyond loopback); a Host/Origin guard defends against browser DNS-rebind.
- **Inward (to backends):** an MCP client per `auth:"oauth"|"header"` backend, each with its own credential keyed by **canonical resource URI** (RFC 8707). Per-backend failure is isolated — a dead backend never takes down the gateway or the others.
- **Injection:** `resolveMcpServers()` partitions servers into *direct* (today's per-agent path) vs *gateway-managed*; when the gateway is up it injects ONE http entry (`zeros-gateway` for user-global, `zeros-gateway-repo` per repo) and removes those backends from direct injection.

### 3.5 Token custody — the biggest blocker, and the shipped mechanism

**The blocker:** the gateway runs in the engine; the engine has **no keychain access** (only Electron `safeStorage` does). **The mechanism (P0-1, shipped):** the in-engine vault persists over the **existing private host↔engine pipes** — never the renderer, the relay, or any log:
- **Restore** via engine **stdin** (`host.mcpVault`, buffered in `mcpVaultSeed` until the vault exists).
- **Persist** via a **dedicated control fd (fd 3, `ZEROS_CONTROL_FD`)** the sidecar reads → `safeStorage` under account **`mcp_oauth_vault`** (main-only — deliberately **NOT** the renderer-allowlisted `mcp::` prefix, so renderer XSS can't read OAuth/header secrets). Persist writes are coalesced with a 250 ms debounce. Shared wire format: `gateway/vault-persist.ts`. The control fd is kept off stdout/`main.log`, and the vault is never put on a child's env (so agent subprocesses can't inherit it).

---

## 4. The unified secret model (two tiers)

There isn't one secret store — there are **two tiers, decided by how the secret is *consumed***. Both share one invariant: **a plaintext secret NEVER lives in `settings.toml`; every secret lives in `safeStorage`.**

| Tier | Used by | Stored in | Who can read | Reaches the agent via |
|---|---|---|---|---|
| **Process-env** | provider API keys · stdio MCP `env` · secret `[env]` values | `safeStorage` under **renderer-allowlisted** accounts (`mcp::<NAME>`, `env::<NAME>`, `anthropic-api-key`/`openai-api-key`/`cursor-api-key`/`factory-api-key`/`github-pat`, `agent::`) | renderer (it couriers them — by necessity) | injected into the agent's **process env** at spawn |
| **Connection** | OAuth tokens · static `auth:"header"` secrets | `safeStorage` under the **engine-only** `mcp_oauth_vault` (NOT the `mcp::` prefix) | **engine only** | the gateway adds them to the **MCP connection**; the agent hits localhost with no secret |

**Why headers can't be process-env:** an HTTP header rides the *connection*, not the env, so the env-courier physically can't carry it — and a directly-injected header **leaks on Codex** (it lands on the `-c http_headers=` command line, visible to `ps eww`). Claude (in-memory) and Cursor (stdin) are safe, but you can't inject directly for all three without the Codex leak. So secret headers must be gateway-brokered — exactly like an OAuth token.

**Codex `ps` leak avoidance:** the `${zeros.secret}` sentinel is stripped from the registry by the engine (`stripSecretSentinels`, applied to **both** `env` and `headers`), so a sentinel'd secret never reaches Codex's `-c` line. A *raw* secret typed into an `auth:"none"` header is the user's choice and the panel warns against it (and it **still leaks on Codex** — the only leak-free path for a secret header is `auth:"header"`).

**Renderer/XSS blast radius:** OAuth + header secrets are engine-only (`mcp_oauth_vault`), so an XSS can't read them. Provider keys + stdio env + `[env]` secrets remain renderer-readable **by necessity** (the renderer couriers them into the process env) — an accepted, documented tier boundary.

**The consistency is the *model*, not a merged screen.** The three surfaces (Providers / Environment / MCP) stay separate — they have different curation needs (Providers has validation + model lists + an auth-method toggle) — but all obey the two-tier model.

---

## 5. How each user-facing mechanic works

**settings.toml layering.** Precedence weak→strong: `default < user < repo < repo-local < workspace-local < managed`. `mcp.servers` is an **array** that *replaces whole* on a normal merge, so `resolveMcpServers()` reads each layer's **own** array and concatenates (highest-precedence first, dedup first-wins; the dedup key is JSON-encoded so `["a b"]` ≠ `["a","b"]`). User file: `~/.zeros/settings.toml` (dev: `~/.zeros-dev/`). Repo files: `<repo>/.zeros/settings.toml` (committed) + `settings.local.toml` (gitignored).

**Authentication — three shapes.**
1. **stdio env secret** (e.g. `GITHUB_TOKEN`): at **User** scope, click the 🔒 lock → value → Keychain `mcp::<NAME>`, sentinel in settings → couriered into the agent's env. *(The 🔒 is offered at the **User** scope only — the courier reads the User layer only, so at repo/workspace scope the panel shows an explicit hint instead of a silent-fail lock.)*
2. **OAuth** (`auth:"oauth"`, e.g. Linear/Notion/Fabric): add the http server, choose **OAuth (via Zeros gateway)**, click **Sign in** → one browser consent → the gateway holds the token → all agents reach the server through localhost. Headless? Use the paste-code flow.
3. **Static API-key header** (`auth:"header"`): choose **"API key / header (via Zeros gateway)"**, enter the header name + value → the value goes to the engine vault (`mcp.gateway.setHeaderSecret`), not settings, not the renderer, not any command line.

**Header authentication, precisely.** `auth:"none"` → headers injected directly into each agent's native config (fine for non-secret routing headers; a real secret here is plaintext **and leaks on Codex** — the panel warns). `auth:"header"` → the gateway adds the secret header to the backend connection; the agent only sees localhost. `auth:"oauth"` → gateway brokers the bearer token; the `headers` field is **not used for auth** (the UI hides the header editor for oauth — note the values still round-trip through the pure draft helpers; they're simply ignored for the connection).

**Importing from other tools.** Settings → MCP → **Import**. The engine scans (read-only, 8 MB cap, never throws):
- `~/.cursor/mcp.json`, `~/.claude.json` (**incl. `projects["<path>"].mcpServers`** — top-level wins on a name clash), `~/.codex/config.toml`, `~/.factory/mcp.json`, Claude Desktop (macOS), plus each open repo's `.cursor/mcp.json` + `.mcp.json`.
- On import: a secret-shaped **stdio env** value (matched by **name**) → Keychain (sentinel in settings). A secret-shaped **HTTP header** (matched by name **or value shape** — `Bearer …`, `sk-/ghp_/xox…/AKIA…`, long opaque tokens) → `auth:"header"` brokered through the gateway vault; a **second** secret header is **dropped with a `toast.warning`** naming it. "Already added" is checked against the **composed (all-layer)** set. OAuth servers still need a one-time **Sign in** after import.

**Scopes & per-repo gateways.** Open a repo → Settings → MCP shows **Shared / This Mac / This Workspace**. A `repo`/`repo-local` `auth:"oauth"|"header"` server is fronted by a **per-repo gateway** (`zeros-gateway-repo`, ephemeral port, keyed by the main checkout); a chat in that repo — including the **primary checkout** (`repoKey = mainRepoRoot ?? cwd`) — gets it; a chat outside doesn't. The gateway modes are offered at **User + Shared + This Mac** but **not workspace-local** (no stable gateway key → warned + dropped). First chat in a repo may spawn before the repo gateway is up; the next chat picks it up (surfaced via a `repoBackendsPending` warning, never fully silent).

---

## 6. OAuth flow & the security must-solve list — verified status

The gateway implements the OAuth 2.1 client flow (spec 2025-11-25) per backend, on first connect or a 401: **probe → PRM discovery (RFC 9728) → AS-metadata discovery (RFC 8414 + OIDC) → PKCE gate → client identity → authorize (system browser + loopback callback) → callback (validate `state`) → exchange (`resource`-keyed token) → use (`Authorization: Bearer`) → refresh.**

The table below is the security/correctness "must-solve" list from the original gateway plan, **annotated with the 2026-06-30 verified implementation status** — this is where the re-audit adds the most value (turning a plan into a verified status, and flagging where the older docs over-claimed).

### P0 — security-critical

| # | Requirement | Status | Evidence / note |
|---|---|---|---|
| 1 | **Resource-URI-keyed token vault** (distinct token per server; never send A's token to B) | ✅ Implemented | Vault is `Map<resourceUri,…>`, key = `canonicalResourceUri(backend.url)` (RFC 8707); per-key isolation tested |
| 2 | **No token passthrough / confused deputy** | ✅ Implemented | Separate `OAuthClientProvider` + separate token per backend; public client `token_endpoint_auth_method:"none"` + PKCE |
| 3 | **SSRF during discovery** (block private/reserved IPs; HTTPS-only; redirects; DNS-rebind) | ✅ Implemented + hardened | `oauth-url.ts` IP classifier (HTTPS-only + all reserved ranges + CGNAT/multicast/IPv4-mapped) **and** `safe-fetch.ts`: `redirect:"manual"` + re-validate **every hop** + **DNS-resolution check** (fail-closed) + strip `Authorization` across hops + refuse non-GET redirects + hop cap. Residual resolve→connect TOCTOU documented |
| 4 | **PKCE downgrade refusal** (S256 only) | ✅ Implemented | `saveDiscoveryState` throws "refusing a PKCE downgrade" if `code_challenge_methods_supported` is absent or lacks `S256`; SDK also enforces. Tested |
| 5 | **`state` / CSRF** on the loopback callback | ✅ Implemented | `randomBytes(32)` state; validated in both interactive and headless paths; missing `code` rejected |
| 6 | **Redirect-URI validation** (exact loopback path) | ✅ Implemented | Callback bound to `127.0.0.1:<callbackPort>`; handler 404s any path ≠ `/callback`; same URL is the sole registered `redirect_uris` |
| 7 | **Token at-rest** (safeStorage only; never plaintext/logged; bind 127.0.0.1) | ✅ Implemented | Only durable sink is encrypted safeStorage; control fd kept off logs; agent server + callback both bind `127.0.0.1` explicitly |
| 8 | **Issuer / mix-up binding** | ⚠️ Partial | Enforced **at discovery time** (`saveDiscoveryState` aborts on `issuer` mismatch), so mix-up is prevented — but the binding is **not persisted on the token blob** (the SDK `OAuthTokens` type has no `issuer` field). Mix-up is blocked; "tokens carry the issuer" is not literally true |

### P1 — correctness / robustness

| # | Requirement | Status | Evidence / note |
|---|---|---|---|
| 9 | **No-DCR servers** — fallback client-identity chain | ⚠️ Partial | Real chain: **static `client_id` → DCR (RFC 7591) → `needs-auth`**. **CIMD is NOT implemented** (the older doc listed it as a step; there is no client-id-metadata-document support) |
| 10 | **Plain-API-key servers** (static header, no discovery/refresh) | ✅ Implemented | `auth:"header"` gateway mode (Phase A): connect branches on `auth`, builds the transport with `requestInit.headers` from the vault, reports `connected` immediately |
| 11 | **Token expiry + refresh + clock skew** | ⚠️ Partial — **reactive only** | Refresh is **purely reactive-on-401** (SDK-driven). **There is NO proactive/timed refresh** — no `expires_at`/margin/80%-lifetime/≥60 s-skew logic exists. The older docs' "proactive refresh before expiry" is **unimplemented** (works in practice because the SDK re-auths on the 401) |
| 12 | **Refresh-token rotation** (persist rotated RT; single-flight) | ✅ / ⚠️ | Rotation **persisted** (`saveTokens` writes the whole blob each refresh; tested). Single-flight **per backend** (`runOnBackend` lock). `invalid_grant → drop + re-auth` is **not an explicit branch** — a failed refresh degrades to `401 → needs-auth`; a corrupt persisted store silently starts empty |
| 13 | **Multiple servers, same provider** (per-resource tokens) | ✅ Implemented | Resource-URI keyed vault → per-resource isolation even when the provider is shared |
| 14 | **Scope handling + step-up on 403** | ⚠️ Partial | Scope comes from the 401/metadata via the SDK; an explicit `403 insufficient_scope` step-up re-authorize is not separately implemented (degrades to re-auth) |
| 15 | **Discovery URL probing order** (PRM path/root + AS-metadata variants) | ✅ Implemented | SDK-driven: PRM path-aware then root; AS metadata ordered well-knowns (OAuth + OIDC variants) |
| 16 | **Backend down / partial failure isolation** | ✅ Implemented | Per-backend try/catch in `connectBackends`; a failed backend → status `error`/`needs-auth` + `continue`; the healthy union is still served. Tested |
| 17 | **Reconnect** — re-attach token | ✅ Implemented | The SDK transport's `authProvider` re-attaches the (possibly refreshed) token on reconnect |
| 18 | **Tool-name collisions + 40-cap** | ✅ Implemented | `server__tool` namespacing + `disabled_tools` allowlist **enforced** (filtered) in `connectBackends`. (Namespacing detail in §9) |

### P2 — UX / environment

| # | Requirement | Status | Evidence / note |
|---|---|---|---|
| 19 | **No browser / headless** | ✅ Implemented | `beginAuthorize`/`completeAuthorize` print-URL-and-paste-code flow, same `state` validation |
| 20 | **Loopback port-in-use / firewall** | ⚠️ Partial | The **user gateway uses fixed ports** → a bind conflict surfaces as **"Gateway unavailable"** (not a silent miss). Per-repo gateways use ephemeral `:0`. Copy/paste fallback exists |
| 21 | **Consent UX** (Sign in / Re-auth / Disconnect per server) | ✅ Implemented | Per-server status pill + Sign-in / Disconnect controls in the MCP panel |
| 22 | **Gateway lifecycle vs sessions** (reload without dropping live sessions) | ✅ Implemented | User-gateway reload serialized on `gatewayReloadChain` (no fixed-port double-bind); the agent↔gateway endpoint stays stable, only the backend set changes; per-repo reloads are per-key serialized |

**Version-dependent flags (context):** DCR drifted `SHOULD`(06-18)→`MAY`(11-25)→deprecated(RC) — treated as last resort. CIMD is new/sparse — **not adopted** (see #9). OIDC discovery is required as of 11-25. SDK pinned v1.

---

## 7. Audit findings (resolved)

The 06-24 audit confirmed **35 issues across 9 dimensions** (each adversarially re-verified) and **rejected 7 false positives**. **All fixes below are applied and test-covered** unless marked *(documented limitation)*. The 06-30 re-audit re-confirmed every fix is still present in the code.

### Critical
| # | Issue | Fix |
|---|---|---|
| **C1** | **SSRF via redirect-follow.** `guardedFetch` validated only the *initial* URL, then `fetch` followed 30x redirects to `169.254.169.254` / internal IPs (cloud-metadata reach from the long-lived engine; hit on the passive boot connect too). | `gateway/safe-fetch.ts`: `redirect:"manual"` + re-validate **every hop** + DNS-resolution check + strip `Authorization` across hops + refuse non-GET redirects + hop cap. **11 tests.** |

### High
| # | Issue | Fix |
|---|---|---|
| **H1** | **MCP secrets leak to remote devices.** `redactDocForRemote` masked only the top-level `[env]` — `mcp.servers[].headers`/`.env` (incl. an `auth:"none"` `Authorization: Bearer …`) went to paired relay/web/mobile devices in cleartext. | `redactMcpTable` recurses + masks all MCP header/env **values** (names stay visible; mask token `<redacted>`). **4 tests.** |
| **H2** | **DNS-rebinding SSRF** undefended (a hostname resolving to a private IP passed the literal-only guard). | The `safe-fetch.ts` DNS-resolution check rejects hosts resolving to reserved ranges (fail-closed; residual TOCTOU documented). |

### Medium (all fixed)
| # | Issue | Fix |
|---|---|---|
| **M1** | Agent-facing gateway had **no Host/Origin validation** — a browser DNS-rebind could drive the token-holding gateway. | `isAllowedRequest()` — exact loopback `Host` allowlist + reject any foreign `Origin` (403). **Test.** |
| **M2** | **Repo-scope env secret silently dropped** (courier reads the User layer only). | The 🔒 env-secret toggle is now **User-scope only**; other scopes show an explicit hint. *(Full per-layer courier = documented follow-up — §8.)* |
| **M3** | **Committed repo OAuth/header server never injected in a repo's primary checkout** (no `workspaceId` → `mainRepoRoot` undefined → entry skipped silently). | `repoKey = mainRepoRoot ?? cwd`; de-gated the "pending" diagnostic so a dropped backend is never fully silent. |
| **M4** | **Scan missed Claude Code project-scoped servers** (`projects["<path>"].mcpServers`). | Scan merges them (top-level wins on a name clash). **Test.** |
| **M5** | **Import copied secret headers plaintext** when the header *name* didn't regex-match. | Detect by **value shape** too; route to the gateway vault. |
| **M6** | **Import silently dropped a second secret header.** | Now collected + surfaced via `toast.warning`. |
| **M7** | **User-gateway reload unserialized** — concurrent saves could double-bind the fixed port / orphan clients. | Serialized onto `gatewayReloadChain`. |

### Low / Info (fixed)
- **L1** PKCE downgrade not enforced → `saveDiscoveryState` **refuses** metadata lacking `code_challenge_methods_supported: ["S256"]`. **2 tests.**
- **L2** Boot registry divergence (boot read the *merged* doc; a managed `mcp.servers` would drop all user servers) → boot now uses `resolveMcpServers().servers` (per-layer concat), matching per-session.
- **L3** Codex TOML escaping missed `\r`/`\b`/`\f`/NUL → could break the *entire* `-c` parse → escaper now covers all C0 controls (`/[\x00-\x1f]/`). **Test.**
- **L4** Reserved gateway-name collision (`zeros-gateway`/`zeros-gateway-repo`) → such names are dropped with a warning (in `agents/gateway.ts`, when the corresponding gateway is injected).
- **L5** Import "already added" check was User-layer only → now uses the composed (all-layer) set.
- **Info:** `oauth` `headers` ignored-for-auth → schema documents it; Codex `.type` docstring drift → fixed; stdio dedup key space-join ambiguity → JSON-keyed. **Test.**
- **Bonus:** `mcp-registry.ts` had been committed as a **binary blob** because the stdio dedup line contained literal **NUL bytes** (the "spaces" were `\0`). Rewriting that line to a JSON key removed the NULs — the file is normal text again.

### Correctly rejected (7 false positives)
Headless `completeAuthorize` CSRF (state validated when present; bare code is user-pasted), imported OAuth servers "become unauthenticated" (only `auth:"oauth"` routes to the gateway, by design), late-vault-seed races, vault-restore clobber, control-fd partial-write, and the reload "drops live sessions" comment — all traced to benign execution orderings by the verifiers.

---

## 8. Known limitations & deferred work

Documented, accepted, and (mostly) low-value-for-effort:

- **Per-repo secret env courier is still User-scope only** (M2 gates the UI; full per-layer courier is a follow-up).
- **OAuth refresh is reactive-on-401 only** — no proactive/timed refresh (see §6 #11 and §9). Acceptable today; a proactive margin is the natural follow-up if a provider's reactive re-auth proves janky.
- **CIMD client-identity is not implemented** (§6 #9, §9). Static `client_id` / DCR / re-auth cover the common cases.
- **A worktree on a branch whose committed MCP list differs from the main checkout** injects `zeros-gateway-repo`, but the per-repo gateway fronts the **main checkout's** committed set (repo-shared backends are main-checkout-canonical).
- **`auth:"none"` secret headers still leak on Codex** (the only leak-free secret-header path is `auth:"header"`; the panel warns). By design.
- **Cloud/account-managed MCP** (Claude.ai connectors, Cursor team MCP) is mostly not importable — pass-through only where the agent fetches it itself (Appendix E).
- **Import scan covers Cursor / Claude Code / Codex / Factory / Claude Desktop + per-repo files only.** VS Code (`.vscode/mcp.json`, key `servers`), Windsurf, and Zed (key `context_servers`) appear in the config-shape reference (Appendix B/E) but are **not yet scanned** — a low-effort follow-up if users ask.
- **Phase 2c — Zeros' own MCP server — not started** (the first *internal* backend behind the gateway). Design constraints carried over from the foundation research (Appendix A, "server-side"): it must be a **real local stdio/HTTP server**, *not* a Claude-only `createSdkMcpServer` in-process server — Codex and Cursor can't consume an in-process SDK server, so serving all three from one implementation requires a real local server (Claude may *additionally* get the low-latency in-process path). It registers through the **same unified registry** as everything else — the built-in, always-on entry (Flow C) and, behind the gateway, the first internal backend. The gating constraint (the original reason it was parked) is the **`apply_change` worktree bug**: writes must resolve against the *calling agent's* worktree, not the engine root, so the server must be **workspace/worktree-aware** (it needs the session's `workspaceId`/worktree path). That workspace-awareness is the one piece of real design work specific to it.

---

## 9. Drift corrected (doc ↔ code reconciliation)

### 9.1 Corrected by the 06-24 audit (now reflected above)
- "auth:'header' is a PLAN, no code yet" → **shipped**.
- "per-repo OAuth is deferred / user-global only" → **per-repo gateways shipped** (only `workspace-local` is dropped).
- "Cursor 40-cap / `disabled_tools` is deferred (dedupe only)" → **enforced** (filtered in the aggregator).
- "`server.ts` unit test deferred" → **exists** (with the DNS-rebind test).
- Token custody mechanism: the `MCP_TOKEN_SET`-over-the-bridge sketch → **superseded** by stdin-restore + control-fd-persist.
- Gateway runtime: Node host subprocess → **superseded** by in-engine (bun).

### 9.2 New drift found in the 06-30 re-audit (the 06-24 doc missed these)
These are **doc-vs-code accuracy** issues — the *code is safe*; the *older docs over-claimed*. Corrected in §6 above; listed here so nobody tests against a stale promise.

| Finding | Older claim | Reality |
|---|---|---|
| **Proactive OAuth refresh** | gateway plan §5/§6: "proactive refresh before expiry (~80% / ≥60 s skew)" | **Not implemented.** Refresh is purely reactive-on-401 (SDK-driven). No `expires_at`/margin logic anywhere |
| **CIMD client identity** | gateway plan §5/§6: client chain "pre-registered → CIMD → DCR → prompt" | **CIMD absent.** Real chain: static `client_id` → DCR → `needs-auth` |
| **`invalid_grant → re-auth`** | gateway plan §5: explicit drop + re-auth | **No explicit branch.** Degrades to `401 → needs-auth`; corrupt store starts empty |
| **Token blob shape** | gateway plan §4: blob `{…, expires_at, …, issuer}` | SDK `OAuthTokens`: has `expires_in` (relative), **no `expires_at`**, **no `issuer`**. Issuer binding exists only as a discovery-time guard (§6 #8) |
| **"Fixed port base+8"** | gateway plan §10: "fixed base+8" framing | True for the **user/global** gateway only; **per-repo gateways use ephemeral `:0`** |
| **Tool-name sanitizer** | gateway plan §2: namespacing sanitizes "anything outside `[A-Za-z0-9_-]`" | Server-prefix keep-set is `[A-Za-z0-9-]` — it **also collapses `_`** (by design, so a server name can't forge the `__` delimiter); **tool names are passed through verbatim**, and routing uses an explicit `route` map (not string-splitting), so a `__` inside a tool name can't mis-route |
| **Reserved-name guard location** | audit L4: implied in `mcp-registry.ts` | Lives in `agents/gateway.ts` and fires **only when the matching gateway endpoint is actually injected** |
| **Schema defaults** | secrets plan: `auth` default `"none"`, `header_name` default `"Authorization"` | Behavioral, **not** zod `.default()` — `"none"` by omission; `"Authorization"` materialized at resolve time (`s.header_name || "Authorization"`) |

### 9.3 Minor code follow-ups noticed (non-blocking)
- **`factory-api-key` allowlist sync drift:** it's in the main-process renderer allowlist (`electron/keychain-accounts.ts`) but missing from the renderer's own `SECRET_ACCOUNTS` source-of-truth (`src/native/secrets.ts`), whose comment says the two "MUST stay in sync." Low risk; worth a one-line fix.
- **Two separate secret-name regexes:** `looksSecretEnvName` (`mcp-secrets.ts`, used by the *import* wizard) and `isSecretEnvName` (`env-names.ts`, the *spawn-time* backstop) are independent patterns (the spawn one is broader). Intentional but easy to mistake for one shared helper.
- **Sentinel-in-an-http-header is a quiet dead-end:** the engine strips `${zeros.secret}` from `headers`, but the env-courier never reads headers, so a sentinel placed in a header is couriered nowhere (does nothing). Matches the "header secrets go through the gateway" stance, but it's silent rather than a warning.

---

## 10. Test plan

### 10.1 Automated coverage (verified green 2026-06-30)

**193 tests pass across 16 core MCP suites** (`npx vitest run --config vitest.config.ts` over the list below). The broader MCP-touching set is ~436 `it()` across 37 files (incl. adapter/probe suites).

| Suite | Tests | Covers |
|---|---:|---|
| `gateway/__tests__/safe-fetch.test.ts` | 11 | redirect & DNS SSRF (C1/H2) |
| `gateway/__tests__/server.test.ts` | 5 | aggregation, header mode, backend isolation, **DNS-rebind guard** (M1) |
| `gateway/__tests__/oauth-provider.test.ts` | 12 | resource-URI vault isolation, **PKCE refusal** (L1), rotation persist, client-info |
| `gateway/__tests__/oauth-url.test.ts` | 20 | SSRF IP classifier, canonical resource URI, issuer mix-up guard |
| `gateway/__tests__/aggregate.test.ts` | 8 | `server__tool` namespacing, collisions, routing |
| `gateway/__tests__/vault-persist.test.ts` | 8 | engine-only account, wire format, `mcp::`-prefix exclusion |
| `agents/__tests__/mcp-registry.test.ts` | 32 | layering, RCE gate, partition, dedup, reserved names, workspace-local drop |
| `agents/__tests__/mcp-scan.test.ts` | 8 | all sources, project-scoped merge (M4), never-throws |
| `agents/__tests__/gateway-mcp.test.ts` | 3 | per-session resolution incl. committed-repo stdio gating |
| `adapters/codex/__tests__/mcp-overrides.test.ts` | 5 | `-c` TOML escaping incl. **control chars** (L3), name-injection guard |
| `settings/__tests__/redact.test.ts` | 4 | **MCP secret masking for relay** (H1) |
| `settings/__tests__/spawn-env.test.ts` | 25 | secret-shaped drop, credential-redirect layering, sentinel pass-through |
| `workspace/__tests__/settings-ops.test.ts` | 12 | `REMOTE_WRITE_DENYLIST`, remote-key-denied, redacted-write guard |
| `src/zeros/agent/__tests__/mcp-secrets.test.ts` | 6 | sentinel courier, **"never scans headers"** invariant, user-layer-only |
| `src/zeros/agent/__tests__/env-secrets.test.ts` | 4 | Phase D `env::` courier |
| `src/zeros/panels/__tests__/mcp-panel-helpers.test.ts` | 30 | draft↔server round-trip, auth modes, allowlist helpers |

**Reproduce:**
```bash
npx vitest run --config vitest.config.ts \
  src/engine/agents/gateway \
  src/engine/agents/__tests__/mcp-registry.test.ts \
  src/engine/agents/__tests__/mcp-scan.test.ts \
  src/engine/agents/__tests__/gateway-mcp.test.ts \
  src/engine/agents/adapters/codex/__tests__/mcp-overrides.test.ts \
  src/engine/settings/__tests__/redact.test.ts \
  src/engine/settings/__tests__/spawn-env.test.ts \
  src/engine/workspace/__tests__/settings-ops.test.ts \
  src/zeros/agent/__tests__/mcp-secrets.test.ts \
  src/zeros/agent/__tests__/env-secrets.test.ts \
  src/zeros/panels/__tests__/mcp-panel-helpers.test.ts
```

**Recommended follow-up automated tests (not blocking, larger):** an end-to-end gateway OAuth flow (real browser/loopback), a gateway reload/late-seed/port-conflict lifecycle test, and a Cursor-host streaming check. Best validated by the manual workflows (C, F, I-6, J-2) below for now. A targeted unit test for reactive-refresh-on-401 + rotation would also pin §6 #11/#12.

### 10.2 User-centric manual workflows

Run in **Zeros Dev**. Useful paths/ports: user settings `~/.zeros-dev/settings.toml`; user gateway `http://127.0.0.1:24301/mcp`, OAuth loopback `:24302` (Stable `:24201`/`:24202`; Beta `:24211`/`:24212`); **per-repo gateways use ephemeral ports**. After most changes the gateway reloads async — give it ~2 s (the panel re-polls). "All three agents" = start a chat with **Claude**, **Codex**, and **Cursor** and confirm the tool appears in each.

**A — stdio server, no secret (the 80% case)**
1. Settings → MCP (User) → **Add server** → stdio, name `context7`, command `npx`, args `-y` / `@upstash/context7-mcp` → Save.
2. **Expect:** appears in the list; `~/.zeros-dev/settings.toml` has a `[[mcp.servers]]` entry; **no restart needed**.
3. Start a chat in each agent → the `context7` tools are available in **all three**.
4. Toggle **enabled off** → next chat in each agent no longer has it.

**B — stdio server WITH a Keychain secret (User scope)**
1. Add stdio `github` (e.g. `npx -y @modelcontextprotocol/server-github`), add env `GITHUB_TOKEN` → click the **🔒 lock** → paste a real PAT → Save.
2. **Expect:** settings stores `GITHUB_TOKEN = "${zeros.secret}"` (no raw token); Keychain has `mcp::GITHUB_TOKEN`.
3. Start a chat → the server authenticates (token couriered into the agent's env). Verify the GitHub tools work.
4. **Codex `ps` check:** while a Codex chat runs, `ps eww | grep codex` → confirm the token is **NOT** on the command line.

**C — OAuth remote server, "authenticate once" (the gateway payoff)**
1. Add an http server with a real OAuth MCP endpoint (e.g. Linear `https://mcp.linear.app/mcp` or Notion), choose **OAuth (via Zeros gateway)** → Save.
2. **Expect:** the row shows **"OAuth · sign in"** and the gateway starts (`mcp.gateway.status.running = true`); if a port is taken you'd see **"Gateway unavailable"**, not silence.
3. Click **Sign in** → one browser consent → the row flips to **Connected (N/M tools)**.
4. Start a chat in **all three** agents → the OAuth tools are available with **no further login**.
5. Restart the app → the row is still **Connected** (token survived via `safeStorage`). **Disconnect** → "needs sign-in"; tools gone next chat.
6. **Headless:** on a no-browser machine, "Sign in" → you get a URL to open elsewhere → paste the resulting code back → Connected.
7. *(Refresh check, optional)* Leave the connection idle past the access-token lifetime, then make a tool call → it should re-auth transparently on the 401 (reactive refresh; there is no proactive pre-expiry refresh — see §6 #11).

**D — Static API-key header via the gateway (`auth:"header"`)**
1. Add an http server needing a static bearer/API key, choose **"API key / header (via Zeros gateway)"**, header name `Authorization`, value `Bearer <token>` → Save.
2. **Expect:** settings has `auth = "header"` + `header_name` but **no value**; the value is in the engine vault (not the `mcp::` Keychain). Row shows tool count or "API key not set" if skipped.
3. All three agents reach the server through localhost — verify a tool call works; confirm via `ps eww` the key is on **no** command line.

**E — Import / adopt from another tool**
1. Have a server configured in Cursor (`~/.cursor/mcp.json`) and/or a **project-scoped** Claude server (`~/.claude.json` → `projects[...]`).
2. Settings → MCP → **Import** → confirm both surface (project-scoped Claude server included); already-in-Zeros servers show **"Already added"**.
3. Select + Import. **Expect:** secret stdio env → Keychain; a secret HTTP header → `auth:"header"` (vaulted); two secret headers → a `toast.warning` names the dropped one. Imported servers work in all three agents (OAuth still needs a one-time **Sign in**).

**F — Per-repo / per-workspace scope**
1. Open a repo → Settings → MCP shows **Shared / This Mac / This Workspace**.
2. Add a stdio server under **Shared** (committed `repo`): allowed but **stdio is RCE-gated** — a chat in that repo logs "stdio servers from the committed repo file are ignored"; declare it under **This Mac** instead and confirm a chat in the repo gets it, while a plain folder chat does **not**.
3. Add an **OAuth** server under **Shared** or **This Mac** → a **per-repo gateway** starts; a chat **in that repo (incl. the primary checkout)** gets `zeros-gateway-repo`'s tools; a chat outside the repo does not. *(First chat may precede gateway start — the next chat picks it up.)*
4. **This Workspace** OAuth/header → expect a warning that the gateway isn't supported at that scope (use This Mac/Shared/User).

**G — Cursor 40-tool budget (allowlist)**
1. With a gateway-fronted server exposing many tools, set `disabled_tools` (the allowlist) on it.
2. **Expect:** the gateway's reported tool count drops (e.g. "12/40 tools") and the agents only see the enabled subset.

**H — Pass-through (existing native config still works)**
1. Without importing, confirm a server already in `~/.cursor/mcp.json` / `~/.claude.json` / `~/.codex/config.toml` still works **in that agent** when run from Zeros (we never isolate `HOME`/`CODEX_HOME`).

**I — Security / negative tests (the important ones)**
1. **Remote redaction:** pair a web/mobile device; with an `auth:"none"` http server carrying an `Authorization` header (and a stdio server with an env secret), read settings on the remote → the header/env **values** show `<redacted>` (names still visible).
2. **Remote write denial:** from the remote device, try to add/edit an MCP server → denied (`mcp` is write-denylisted) — confirms no RCE-by-remote-settings.
3. **Gateway ops are desktop-only:** the remote device cannot reach `mcp.gateway.*` / `mcp.scanNative` (they throw "desktop-only").
4. **SSRF (if you can stand up a hostile server):** point an `auth:"oauth"` server at one whose discovery/token endpoint `302`s to `http://169.254.169.254/` or whose hostname resolves to a private IP → the gateway **blocks** it (engine log: "blocked an unsafe URL …"); the server shows error, not a hang, and no internal fetch occurs.
5. **DNS-rebind on the gateway endpoint:** a cross-origin/foreign-Host POST to `127.0.0.1:24301/mcp` → **403** (a normal agent connection still works).
6. **Gateway-unavailable surfacing:** occupy port 24301, then add an OAuth server → the panel shows **"Gateway unavailable"** (not a silently-missing server).

**J — Edge / robustness**
1. Hand-edit `~/.zeros-dev/settings.toml` to add a malformed `[[mcp.servers]]` entry among good ones → the bad one is dropped with a warning, siblings + unknown keys preserved, boot/reload never blocked.
2. Rapidly toggle several OAuth servers on/off → no port-bind crash (reload serialized); the agent-facing endpoint stays stable so live chats aren't dropped.
3. Name a server `zeros-gateway` (with a gateway active) → it's ignored with a warning (reserved).

---

## 11. Reference: schema, bridge ops, ports, file map

### 11.1 Settings schema (the http variant)

A gateway-managed server is just an http server with `auth:"oauth"` (the gateway *discovers* endpoints — the user never configures auth/token URLs):

```toml
[[mcp.servers]]
name = "Fabric"
transport = "http"
url = "https://mcp.api.fabric.so/mcp"
auth = "oauth"            # route through the gateway; it brokers OAuth
# auth = "header"         # static API-key mode; pair with header_name (value → vault, never here)
# header_name = "Authorization"
# optional escape hatch for no-DCR providers:
# oauth_client_id = "…"   # non-secret
```

- `auth?: "none" | "oauth" | "header"` (behavioral default `"none"`). `header_name?` (behavioral default `"Authorization"`) names the header only — **the value is never in settings.**
- `env`/`env_files` live on the repo schema and are inherited by the user schema (not in `USER_ONLY_KEYS = ["models","workspaces","tool_approvals_enabled","providers"]`).
- Unknown/malformed `[[mcp.servers]]` entries degrade safely (per-entry drop + warning; siblings preserved).

### 11.2 Bridge ops (all LOCAL-ONLY — they touch tokens / open browsers)

`mcp.scanNative` · `mcp.resolveComposed` · `mcp.gateway.status` (`{running, error, servers[]}` per-server: disconnected / needs-auth / authorizing / connected / error + tool count) · `mcp.gateway.authorize {server}` · `mcp.gateway.disconnect {server}` · `mcp.gateway.beginAuth` / `completeAuth` (headless) · `mcp.gateway.setHeaderSecret {server, headerName, value}`. Each throws `SETTINGS_REMOTE_KEY_DENIED` ("desktop-only") for a remote caller, and they're double-gated (refused by `isRemoteAllowed` before dispatch + an in-handler `if (remote)` backstop). Renderer clients: `bridgeMcpGateway*`.

### 11.3 Ports

| | Server endpoint | OAuth callback |
|---|---|---|
| **User / global gateway** | base + 8 → **24201** Stable / **24211** Beta / **24301** Dev (fixed) | base + 9 → **24202** Stable / **24212** Beta / **24302** Dev (fixed) |
| **Per-repo gateway** | ephemeral `:0` (advertised back) | ephemeral `:0` |

All bound to **127.0.0.1 only**, with the Host/Origin DNS-rebind guard on the agent-facing endpoint.

### 11.4 File map (source of truth)

| Area | Files |
|---|---|
| Gateway | `src/engine/agents/gateway/{server,aggregate,oauth-provider,oauth-url,safe-fetch,open-url,vault-persist}.ts` |
| Gateway wiring / per-repo | `src/engine/agents/gateway.ts`, `src/engine/index.ts` (`repoGateways`, `gatewayReloadChain`, control fd) |
| Registry / schema | `src/engine/agents/mcp-registry.ts`, `src/engine/settings/{schema,resolve,ops,env-names,spawn-env}.ts` |
| Scan / import | `src/engine/agents/mcp-scan.ts`, `src/zeros/panels/mcp-import-dialog.tsx` |
| Secret couriers (renderer) | `src/zeros/agent/{mcp-secrets,env-secrets}.ts`, `src/zeros/panels/provider-prefs.ts` |
| Keychain allowlist | `electron/keychain-accounts.ts` (canonical), `src/native/secrets.ts` (wrapper) |
| Remote redaction / denylist | `src/engine/settings/ops.ts` (`redactDocForRemote`/`redactMcpTable`), `src/engine/workspace/service.ts` (`REMOTE_WRITE_DENYLIST`) |
| Agent adapters | `src/engine/agents/adapters/{claude-sdk,codex,cursor-sdk}/…` |
| UI | `src/zeros/panels/{mcp-panel,mcp-panel-helpers,mcp-import-dialog}.tsx` |

---

## 12. History of record: phasing & resolved decisions

**Shipped commits (for archaeology):** unified MCP config + per-scope servers + secret model (`5f33eede`), gateway hardening + Models settings (`c68f8620`); gateway foundation — SSRF guard + canonical resource URI (`f58803f6`); 2a aggregator + namespacing + injection (`6d4ac4f6`, `94c3084a`); 2b OAuth brokering + token vault + Sign-in UI (`6bb6ed5d`, `5d07db8b`, `5936f91c`); P0-1 token persistence (`24d22282`); P0-2/P0-3 scope guard + failure surfacing (`6c4c3fc2`). *Phase 0–1b foundation, granular pre-squash commits (rolled up into #78 / `5f33eede`):* per-repo/-workspace scope + RCE gate (`dac1c82e`, `32b93cf7`, `d2cfb077`); stdio keychain secret refs (`e62990c4`, `c5db82a3`, `1a14c40a`); Adopt/Import wizard 1b (`884d871f`, `20ce2e96`).

**Phasing (final):**
- ✅ **Phase 0 (pass-through correctness):** the Cursor `settingSources` fix, the `preserveAmbientConfigRoots` "never isolate config roots" guard routed through all three spawn-env builders, and the pre-fan-out dedup seam — so every agent honors the user's *existing* native MCP config out of the box (Appendix E).
- ✅ **Phase 1–1b (foundation):** unified registry, per-agent fan-out, layered scopes, committed-repo RCE gate, stdio-keychain secret model, and the Adopt/Import wizard. *(Foundational research — protocol primer, config fragmentation, competitive case, pass-through/adopt model — now in Appendices A–F.)*
- ✅ **Phase 2-foundation:** SSRF-safe URL guard + canonical resource URI.
- ✅ **Phase 2a:** in-engine Streamable-HTTP aggregator, `server__tool` namespacing, per-backend isolation, single injected entry. *(Tool-allowlist filtering later promoted from "dedupe-only" to enforced.)*
- ✅ **Phase 2b:** per-backend OAuth brokering + token vault + refresh/rotation + Sign-in UI; P0-2/P0-3 per-repo scope guard + "Gateway unavailable" surfacing.
- ✅ **Secrets Phases A–D:** A `auth:"header"` gateway-brokered mode · B import auto-keychains secret headers · C User → Environment section · D secret `[env]` values (`env::<NAME>`).
- ⏳ **Phase 2c:** Zeros' own MCP server — **not started.**

**Open decisions — all resolved:** OAuth flow runs in the in-engine gateway (host only opens the browser + persists the token); user-gateway port fixed at base+8 (per-repo ephemeral); no bearer on the endpoint (loopback-only floor); per-repo gateways shipped (workspace-local still warned+dropped); built the thin aggregator on `@modelcontextprotocol/sdk` (1MCP not used); header servers accept the same gateway-brokered/user-global constraint as OAuth; Phase D shipped alongside A–C; provider keys stay curated in Providers; import header-secret heuristic matches by name **and** value shape.

---

# Appendices — foundational research (absorbed)

> Appendices A–F carry the **foundational research** that the shipped work above was built on. They were absorbed **verbatim-in-substance** from the retired `docs/unified-mcp-config-research-2026-06-20.md` (2026-06-20) when that companion was folded into this doc on 2026-07-01, so this file is now the single, self-contained source of truth. Each claim below was re-verified against the live code (pass-through, fan-out, scan) or against the cited external docs on 2026-07-01. Superseded forward-looking framing from the original research (e.g. its "gateway = extra process / SPOF" cons, its "registry is 60% wired but inert" snapshot) has been dropped or re-framed as history — sections 1–12 above are authoritative where they overlap.

## Appendix A — MCP protocol primer (host / client / server; transports; auth)

The conceptual "why" that sections 1–12 assume. Spec revision **2025-11-25** (latest as of mid-2026). Sources in Appendix F.

**The three-role model.**
- **Host** — the app that runs the model and coordinates everything; it *creates and manages multiple client instances*, enforces consent/permissions, and aggregates context. *(In Zeros, each agent runtime is a host; the Zeros gateway is itself a host to its backends.)*
- **Client** — created by the host; maintains a **1:1 connection to exactly one server**. Five servers ⇒ five clients.
- **Server** — provides tools/resources/prompts; a local subprocess or a remote service.

**Two sides of "MCP in Zeros" — keep them distinct:**

| Side | What it is | Status in Zeros |
|---|---|---|
| **Client-side** (this whole doc) | Zeros configures *external* MCP servers and fans them out to the agents so the model can call their tools | ✅ Shipped |
| **Server-side** (Zeros' own MCP) | Zeros *exposes its own* tools (design/task tools, `spawn_agent`, …) as an MCP server the agents call | ⏳ Phase 2c — not started (§8) |

The unification problem is entirely **client-side**: each agent reads MCP config from a different file, format, and location (Appendix B). The Zeros-own server is just one more entry in the same unified registry once built.

**Transports — the spec defines exactly two (plus optional custom):**

| Transport | Local/Remote | Status | Notes |
|---|---|---|---|
| **stdio** | Local | Current; clients SHOULD support it | Server launched as a subprocess; newline-delimited JSON-RPC over stdin/stdout. Most local servers. |
| **Streamable HTTP** | Remote | Current remote transport (rev 2025-03-26) | Single endpoint, POST + optional SSE stream; `MCP-Session-Id` header. It is **HTTP/1.1** — the reason the gateway can run in-engine under bun (§3.3). |
| HTTP+SSE (two-endpoint) | Remote | **Deprecated** since 2025-03-26 | Superseded by Streamable HTTP; some clients still accept it. |

**Authorization — why "authenticate once" is the hard part:**
- **stdio servers don't use OAuth.** The spec says stdio implementations SHOULD retrieve credentials from the environment → **auth = env vars** (API keys via `env`). Easy to unify: inject the same env var into every agent (this doc's process-env tier, §4).
- **HTTP servers use OAuth 2.1.** The server is an OAuth *resource server*; flow: unauthenticated request → `401` + `WWW-Authenticate` → Protected Resource Metadata (RFC 9728) → Authorization Server Metadata (RFC 8414) → OAuth 2.1 auth-code + **PKCE** + **Resource Indicators (RFC 8707)** → `Authorization: Bearer` on every request. (RFC 9728 + 8707 became mandatory in rev 2025-06-18; 2025-11-25 adds Client ID Metadata Documents and demotes Dynamic Client Registration to backwards-compat.) The gateway implements exactly this flow — §6.
- **Tokens are per-client, by design.** Each client runs its own OAuth flow over its own 1:1 connection and gets a token **audience-bound to one (client, server) pair**. The spec has **no primitive for sharing a token across clients** and forbids passthrough. → For OAuth servers, every agent would re-authenticate separately unless something terminates auth in one place and fronts the agents as a single server. **That "something" is the gateway (§3).** This single fact is why "authenticate once" requires the gateway, not just config fan-out.

**No namespacing in the spec.** Tool names are a flat per-server space; cross-server collisions are a known gap. The `mcp__<server>__<tool>` shape is an **Anthropic/Claude convention**, not MCP. Aggregators add their own prefix (de-facto `ServerName__toolName`) — Zeros' gateway uses `server__tool` with an explicit route map (§6 #18, §9.2). Open proposals: SEP-986, SEP-993.

## Appendix B — Per-agent native MCP config reference (the fragmentation)

Why a unified layer is needed at all: every agent reads MCP from a different place, format, and top-level key. The Zeros-side pass-through status for each is in Appendix E.

**Claude**

| Surface | Config location | Format / key | Transports | Auth |
|---|---|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | JSON `mcpServers` → `{command,args,env}` | stdio; HTTP/SSE via "connectors" | env vars; OAuth for connectors |
| Claude Code (CLI) | user `~/.claude.json`; project `.mcp.json` (repo root) | JSON `mcpServers`; or `claude mcp add` | stdio, http, sse (deprecated) | OAuth 2.0 via `/mcp` (keychain, auto-refresh); `--header`; `headersHelper` |
| **Claude Agent SDK** (Zeros) | **programmatic** `mcpServers` on `query()` | `{type:"stdio"\|"http"\|"sse"\|"sdk",…}` | stdio, http, sse, **sdk (in-process)** | `headers`, `env`; `allowedTools`/`permissionMode` gate execution |

Claude Code scopes resolve **local > project > user > plugin > connectors**; the winning entry is used whole (fields are not merged). The SDK's `createSdkMcpServer` exposes **in-process tools with no subprocess** — the cleanest path for Claude, but Claude-only (see Phase 2c, §8).

**OpenAI Codex** (Zeros via app-server)
- `~/.codex/config.toml` (user) / `.codex/config.toml` (project, trusted only). Each server = a `[mcp_servers.<name>]` table.
- stdio keys: `command` (req), `args`, `env`, `env_vars`, `cwd`. Streamable-HTTP keys: `url` (req), `bearer_token_env_var`, `http_headers`, `env_http_headers`. **HTTP added Sept 2025 (PR #4317)** — Codex was stdio-only before, initially behind `experimental_use_rmcp_client`. **No SSE.** stdio & HTTP keys are **mutually exclusive**.
- `codex mcp add … -- <cmd>` / `--url` writes config.toml; `codex mcp login <name>` for OAuth. Per-server `startup_timeout_sec`/`tool_timeout_sec` + `enabled`/`enabled_tools`/`disabled_tools`.

**Cursor** (Zeros via @cursor/sdk)
- `~/.cursor/mcp.json` (global) / `.cursor/mcp.json` (project — wins on name collision). JSON `mcpServers`.
- stdio: `{command,args,env,envFile}`. Remote: `{url,headers}`. Transports: stdio, SSE, Streamable HTTP.
- **~40-tool cap across all enabled servers combined** (Cursor-staff-confirmed; not in the docs) — the constraint the gateway's `disabled_tools` allowlist addresses (§6 #18).
- OAuth 2.1 browser flow; tokens per-user/global, encrypted at rest, hidden from the agent. One-click deeplink: `cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64` (`config` = base64 of the server config JSON).

**The fragmentation, summarized** (the protocol standardizes the *wire*, not the client config file — which is why every client invented its own):

| Tool | Path | Format | Root key |
|---|---|---|---|
| Claude Code | `~/.claude.json` / `.mcp.json` | JSON | `mcpServers` |
| Codex | `~/.codex/config.toml` | **TOML** | `mcp_servers` (table) |
| Cursor | `~/.cursor/mcp.json` / `.cursor/mcp.json` | JSON | `mcpServers` |
| VS Code / Copilot | `.vscode/mcp.json` | JSON | **`servers`** |
| Zed | `~/.config/zed/settings.json` | JSON | **`context_servers`** |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | JSON | `mcpServers` |

`mcpServers` is a ~60%-adopted convention, not a standard — exactly why Zeros' one registry + native fan-out (§3) is worth building.

## Appendix C — Competitive landscape: nobody unifies MCP

The differentiation case — verified against each product's docs (Appendix F).

- **Conductor.build** — explicitly **no unified MCP**: *"Conductor does not define a separate MCP config format. It uses the MCP configuration that Claude Code and Codex load for the session."* You configure each agent separately; its `file_include_globs` file-copier is the closest mechanism but is not MCP-aware.
- **Orca** (onorca.dev, "the ADE for a fleet of parallel agents") — README has **no mention of MCP**; same pass-through model.
- **VS Code / Copilot** — the most mature *single-tool* story (profiles, Settings Sync, and auto-discovery of *Claude Desktop's* config via `chat.mcp.discovery.enabled`) — but it reads one other tool's file, not cross-agent orchestration.
- **Warp** — one GUI/account-managed MCP store, but only for *Warp's own* agent.

**Net:** "configure an MCP server once → it works in Claude, Codex, and Cursor" exists in **no competing parallel-agent product**. Zeros' unified registry (§3) + "authenticate once" gateway is a clean differentiator.

## Appendix D — Gateway ecosystem survey (build-vs-embed evidence)

The prior-art survey behind the §3.2 "build a thin aggregator on the official SDK" decision. The MCP-aggregator pattern is mature — a Q1-2026 survey catalogs 17+ implementations.

| Product | What it is | Namespacing | Central auth? |
|---|---|---|---|
| **MetaMCP** | OSS aggregator: Servers→Namespaces→Endpoints, middleware | `ServerName__toolName` (recursive) | API key + OIDC |
| **1MCP** | Single `serve` runtime; per-app scoping (`?app=cursor`) | per-server prefix | holds backend creds, single Bearer endpoint |
| **Docker MCP Gateway** | Backends in containers, on-demand; central secrets | not auto-prefixed yet (open issue) | yes — secrets/OAuth injected per call |
| **mcp-proxy** (sparfenyuk/TBXark) | transport bridge + light multi-server hosting | path-/prefix-based | bearer + OAuth2 client-creds |

**Why Zeros built its own instead of embedding one** (full decision in §3.2): every candidate either drags heavy infra (MetaMCP = Postgres + Docker + Next.js; Docker / MCPJungle / k8s variants) or — in 1MCP's case (the closest: real two-way OAuth) — exposes no library API and keeps its own token store, so Zeros would shell out + shim its keychain anyway. Assembling on the official **`@modelcontextprotocol/sdk` v1** gave full control, native keychain custody, and no heavy dependency. What the survey confirmed and Zeros adopted: **`server__tool` namespacing**, **central token custody keyed by resource URI**, **per-backend isolation**, and a **single injected endpoint per agent**.

## Appendix E — Pass-through & cloud-managed MCP ("don't make me reconfigure")

The rationale behind the config-isolation guard (`preserveAmbientConfigRoots`, `adapters/shared/config-isolation.ts`) and the import wizard (§5). Two mechanisms answer two different needs:

1. **Inherit (pass-through)** — Zeros runs the *real* Claude/Codex/Cursor binaries/SDKs, which load their *own* native config unless isolated. A user's existing server keeps working **in that agent** with zero action. → *"my stuff still works."*
2. **Adopt (import/promote)** — take a server configured in *one* agent and promote it into Zeros' shared registry so it works across **all three**. → *"now my Cursor server also works in Claude and Codex."* (This is the Import wizard, §5.)

**Pass-through status (re-verified against the spawn code + each SDK's docs, 2026-07-01):**

| Agent | User MCP loads? | Project MCP loads? | Mechanism |
|---|---|---|---|
| **Claude** (Agent SDK) | ✅ | ✅ | `settingSources:["user","project","local"]` (`claude-sdk/adapter.ts`); SDK `mcpServers` union, highest scope wins on name clash |
| **Codex** (app-server) | ✅ | ✅ (trusted projects) | No custom `CODEX_HOME`; `process.env` spread; `-c mcp_servers.*` overrides are additive/deep-merged on `~/.codex/config.toml` |
| **Cursor** (@cursor/sdk) | ✅ | ✅ | `buildLocalOpts` sets `settingSources:["user","project","team","mdm","plugins"]` (`cursor-sdk/adapter.ts`) — without it the SDK loads only inline servers |

All three pass through today. The invariant that keeps this true: **`preserveAmbientConfigRoots()` never lets a spawn point an agent at an isolated `HOME`/`CODEX_HOME`/`CLAUDE_CONFIG_DIR`/`XDG_CONFIG_HOME`** — overriding any would silently break MCP + repo-rule pass-through (no error; the agent just "doesn't see" the servers). Bonus: a same-OS-user Cursor headless run **reuses OAuth logins already saved in the Cursor app** (though the SDK can't start a *fresh* OAuth flow itself).

**Cloud / account-configured MCP — the honest limits** (these live in a provider's cloud, not on disk, so Zeros generally can't read or export them):
- **Claude.ai connectors** materialize only when the SDK session's auth is the user's **Claude.ai subscription login**, not an API key / Bedrock / Vertex. No API for Zeros to enumerate them.
- **Codex / ChatGPT** — **no** individual-account cloud MCP sync into the local CLI (only enterprise "managed config" pushes servers, and it sits *above* our `-c` overrides).
- **Cursor team/dashboard MCP** — reaches the local agent only via `settingSources:["team"]`/`"all"`; Cursor's own cloud/background agents load user+team MCP automatically.
→ Takeaway: cloud MCP is mostly **not importable**; pass through where the agent fetches it itself, and be transparent in the UI about what's cloud-managed vs local.

**The dedup/collision problem.** Once pass-through *and* the Zeros registry are both active, the same server can be defined twice (native + Zeros). Zeros dedups by identity (name + command/url), first-wins (§5), so nothing double-loads and Cursor's ~40-tool budget isn't wasted; the "managed by Zeros" indicator explains the winner.

**Adopt precedents Zeros followed** (all detect-then-offer, never silent): VS Code `chat.mcp.discovery.enabled` (*"detect … and offer to run them"*); Claude Code `claude mcp add-from-claude-desktop` (interactive select, dedup via numeric suffix, secrets stay in the keychain); `mcpm client import` (per-client managers tagging owned entries for provenance). Distilled rules the Zeros import obeys: opt-in detect-then-offer; normalize the divergent config shapes; dedup with source provenance; import *coordinates* + env *references* but re-prompt for real secrets and **expect re-auth for OAuth** (tokens can't be copied); flag un-importable entries rather than dropping them.

**Definitive scan-list reference** (Appendix B has the format/key detail):

| Client | Path(s) (macOS) | Format | Root key |
|---|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | JSON | `mcpServers` |
| Claude Code | `~/.claude.json` (+ `projects["<path>"].mcpServers`) + `.mcp.json` | JSON | `mcpServers` |
| Codex | `~/.codex/config.toml` + `.codex/config.toml` | TOML | `mcp_servers` |
| Cursor | `~/.cursor/mcp.json` + `.cursor/mcp.json` | JSON | `mcpServers` |
| VS Code | `.vscode/mcp.json` + user config | JSON | **`servers`** |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | JSON | `mcpServers` |
| Zed | `~/.config/zed/settings.json` + `.zed/settings.json` | JSON | **`context_servers`** |

Zeros' shipped scanner (`agents/mcp-scan.ts`, §5) covers **Cursor / Claude Code (incl. project-scoped) / Codex / Factory / Claude Desktop** + per-repo `.cursor/mcp.json` + `.mcp.json`. **VS Code / Windsurf / Zed** appear in this reference table but are **not currently scanned** (deferred — §8).

## Appendix F — Primary sources

Consolidated citations for this doc (verified reachable on the 2026-06-20 research date; MCP spec pinned to revision 2025-11-25).

**MCP spec:** architecture <https://modelcontextprotocol.io/specification/2025-11-25/architecture> · transports <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports> · authorization <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization> · tools <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>

**Claude:** connect-local-servers <https://modelcontextprotocol.io/docs/develop/connect-local-servers> · Claude Code MCP <https://code.claude.com/docs/en/mcp> · Agent SDK custom tools <https://code.claude.com/docs/en/agent-sdk/custom-tools> · Agent SDK TS reference <https://code.claude.com/docs/en/agent-sdk/typescript> · Agent SDK features (settingSources, ~/.claude.json always-read, claude.ai connectors auth-gated) <https://code.claude.com/docs/en/agent-sdk/claude-code-features>

**Codex:** MCP <https://developers.openai.com/codex/mcp> · config reference <https://developers.openai.com/codex/config-reference> · config-advanced (additive `-c`, CODEX_HOME) <https://developers.openai.com/codex/config-advanced> · CLI reference <https://developers.openai.com/codex/cli/reference> · HTTP PR #4317 <https://github.com/openai/codex/pull/4317>

**Cursor:** MCP <https://cursor.com/docs/mcp> · MCP help/security <https://cursor.com/help/customization/mcp> · install links <https://cursor.com/docs/context/mcp/install-links> · SDK TS reference (settingSources gate, OAuth reuse, cloud team MCP) <https://cursor.com/docs/sdk/typescript> · CLI MCP <https://cursor.com/docs/cli/mcp> · 40-tool cap <https://forum.cursor.com/t/increase-the-mcp-tool/69194/2>

**Orchestrators:** Conductor MCP <https://www.conductor.build/docs/reference/mcp> · Conductor settings <https://www.conductor.build/docs/reference/settings/reference> · Orca <https://www.onorca.dev/> · VS Code MCP <https://code.visualstudio.com/docs/copilot/customization/mcp-servers> · VS Code MCP discovery <https://code.visualstudio.com/docs/agent-customization/mcp-servers> + v1.99 <https://code.visualstudio.com/updates/v1_99> · config fragmentation <https://platform.uno/blog/mcp-configuration-across-ai-agents/>

**Gateways:** Docker MCP Gateway <https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/> · MetaMCP <https://github.com/metatool-ai/metamcp> + namespaces <https://docs.metamcp.com/en/concepts/namespaces> · 1MCP <https://github.com/1mcp-app/agent> · mcp-proxy <https://github.com/sparfenyuk/mcp-proxy> · aggregation survey Q1-2026 <https://www.heyitworks.tech/blog/mcp-aggregation-gateway-proxy-tools-q1-2026> · mcpm client import <https://github.com/pathintegral-institute/mcpm.sh>
