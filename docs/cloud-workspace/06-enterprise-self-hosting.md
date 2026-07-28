# Enterprise: Their Servers, Their Data
*Part 06 of the Zeros Cloud Workspaces Report · July 2026*

## The short version

> **Decision (2026-07-02):** Enterprise self-hosting is now a **committed product direction** — "your data never lives in our cloud; it lives in yours" — still phased **after v1 GA**. It rides on the same day's data decision: all durable Zeros data now lives in **the cloud record** (our cloud database that permanently stores your chats, sessions, and workspace history in your account) plus one storage bucket plus git. **Because all durable data = one Postgres schema, self-hosting = pointing Zeros at THEIR database.**

- **Decided 2026-07-02: enterprise self-hosting is committed, not hypothetical.** The star rung: **their Postgres (the record) + their object storage + optionally their sandbox runners**, delivered as Docker Compose/Helm + a license key. Both enterprise rungs — BYOC and full self-host — anchor on the record; timing stays "after v1 GA."
- **Every dev-tool company eventually gets the same email**: "We love the product, but our code and data can never leave our infrastructure." Sourcegraph hit this wall in 2017, pivoted to on-prem, and unlocked Lyft, Uber, and Plaid. AI-agent workspaces holding customer code sit in exactly that category.
- There's a standard **four-rung ladder** of answers: our cloud (SaaS) → their cloud holds the data while we orchestrate (BYOC) → they run everything (self-host) → no internet at all (air-gapped). Each rung costs you more to build and support than the last — and every rung now has a precise answer to "where does the record live?"
- The industry-standard trick is the **control plane / data plane split**: a small "reception desk" you host (logins, the list of workspaces, the button that creates one) and "hotel rooms" that can live anywhere (the sandboxes where code and chat actually sit — plus, since 2026-07-02, the **filing cabinet**: the cloud record that keeps chats and history permanently). The acid test, per Northflank: *can the vendor see the payload?* In real BYOC, the answer is no.
- **Zeros is now shaped for this by design, not accident.** The Mac still connects straight to the sandbox over "the live wire" (the direct WebSocket) with no Zeros server in the middle; the control plane stays a thin reception desk (auth + registry + a provisioning worker); the sandbox vendor sits behind a swappable `CloudSandboxProvider` interface; and — updated 2026-07-02 — chat's permanent home moved from the sandbox to the cloud record, ONE well-defined Postgres schema. Enterprise = point that schema at *their* database and, optionally, the provider interface at *their* machines. — live-path and control-plane claims verified against the internal plan (June v2); the record is the 2026-07-02 decision update.
- **Pricing norms are friendly**: GitHub charges the same $21/user/mo whether you use their cloud or run their server; most dev tools gate self-host/BYOC to a custom enterprise tier at **$20k–$100k+/yr**; BYOC vendors charge no markup on the customer's own compute (as of mid-2026).
- The auth checklist (SAML SSO, SCIM, audit logs) is a **purchase, not a project**: WorkOS-style pricing is ~$125/connection/month, so enterprise-readiness for your first ~10 enterprise customers is roughly $1–3k/month. Committed direction or not: **buy SSO/SCIM, don't build.**
- **Committed does not mean built now. Do not build any of this before v1 GA.** PostHog killed its self-hosted product in 2023 because 3.5% of users consumed a disproportionate share of a small infra team. The right move now is to *design the seams* — starting with the upgraded seam #1: a **configurable record endpoint** (the record's database URL is config, never hard-coded).

## Why this question will show up in your inbox

Picture the workflow eighteen months from now. A platform lead at a 2,000-person fintech tries Zeros, loves running five agents in parallel, and takes it to their security team. The security team asks one question: **"Where does our code go?"** Under the 2026-07-02 decision, the honest answer is "code runs in a Daytona sandbox — a rented computer in Daytona's US or EU data centers — and your chats, sessions, and workspace history live permanently in **the cloud record**: our cloud Postgres, in your Zeros account, encrypted at rest, exportable, deletable." For most startups and mid-size teams, that answer plus a SOC 2 report is fine — "your work is always in your account" is the feature, not a confession. For banks, healthcare, defense, and any company whose crown jewels are the code itself, it is a dealbreaker — no matter how good the product is. That dealbreaker case is exactly what the enterprise rungs below are for: the same software, with the record and the rest of the data plane moved onto *their* servers.

Sourcegraph lived this exact story: through 2017, enterprises loved the demo but refused to "push their private code base to an external software provider." They shipped an on-prem version in December 2017 and the enterprise business took off (verified — Sourcegraph's own blog: *"Trust is great. Control is better."*).

There's a modern counter-example worth holding in mind, though: **Cursor**, at a reported 64%-of-Fortune-500 penetration, offers *no* self-host option at all. They sell enforced Privacy Mode plus zero-data-retention agreements ("ZDR" — a contract where the AI model providers promise to process code in memory and never store it) plus enterprise controls like SCIM and audit logs. Lesson: for AI dev tools in 2025–2026, many enterprises accept "strong tenancy + ZDR + audit" *instead of* self-hosting. Self-host is one answer to "our data stays on our servers" — not the only one, and not the first one to build.

## The ladder: four ways to run Zeros for an enterprise

Think of it as a ladder you climb only when a customer with a signed check pulls you up a rung.

| Rung | Plain-words meaning | Who runs what | Where does the record live? | Real-world example |
|---|---|---|---|---|
| **1. SaaS** (our cloud) | Everything on infrastructure we rent. Default. | We run control plane + sandboxes | **Our cloud Postgres, in your Zeros account** — that's the feature | Zeros today (Daytona + Supabase) |
| **1.5 Single-tenant SaaS** | We still run it, but on a *private, isolated* instance just for them, in their chosen region. | We run everything, separately per customer | A private instance we run just for them | GitLab Dedicated — reportedly ~$26k/month floor (likely, via pricing benchmarks) |
| **2. BYOC** ("bring your own cloud") — ⭐ **the star rung (decided 2026-07-02)** | **Their Postgres (the record) + their object storage + optionally their sandbox runners** — all durable data inside the *customer's* AWS/GCP account, delivered as Docker Compose/Helm + a license key. We keep a hosted control plane that orchestrates from outside. | They own the data boundary; we own the software and ops | **Their Postgres** — chats and history never touch our cloud | Depot, E2B, Northflank; Daytona's "custom regions" |
| **3. Full self-host** | We ship installable software (Docker Compose, a Helm chart — a recipe for running our services on their machines) plus a license key. They run *everything*, including the reception desk. | They run it all; we ship packages and support | **Their Postgres** — and they run the reception desk too | Coder, Sourcegraph, GitLab self-managed, Retool |
| **4. Air-gapped** | Self-host with **no internet at all**: offline install bundles, offline license files, updates carried in on a drive. | They run it all, disconnected | Their machines, with no wire out of the building | Defense/gov deployments via Replicated tooling |

**Decided 2026-07-02:** both enterprise rungs — BYOC (rung 2) and full self-host (rung 3) — anchor on **the record**. And because all durable data = one Postgres schema (plus one bucket, plus git), **self-hosting = pointing Zeros at their database.** That is the whole trick; the rest of this page is the supporting detail.

Two things every experienced vendor will tell you about this ladder (verified across the research notes): BYOC demand exploded in 2024–2026 — driven by regulated industries, GDPR fines (reportedly over €3 billion in the first half of 2025), and AI workloads pinned to reserved GPU capacity — and **air-gap is a different business entirely**, where "every exchange — logs, screenshots, config files — can take hours or days" (Replicated). Rung 4 is for a later, bigger company.

## Reception desk vs hotel rooms: the control plane / data plane split

Here's the one piece of architecture jargon worth learning, because it decides whether enterprise is easy or a rewrite.

Every serious platform splits into two planes:

- The **control plane** is the hotel's *reception desk*: it checks you in (auth), knows which room is yours (the workspace registry), and hands out keys (tokens). It holds **metadata only** — names, membership, health status. Never the contents of your suitcase.
- The **data plane** is the *hotel rooms*: where you actually live and where your stuff is. For Zeros, a data-plane room is one sandbox — the workbench holding the engine, the git checkout, and zeros.db (the live *working copy* of chat and sessions). **Updated 2026-07-02:** the data plane now has a second piece — the **filing cabinet**: the cloud record, where chats, sessions, and history live *permanently* (the sandbox's zeros.db used to be their only home). The filing cabinet holds real content, so it belongs to the data plane, not the reception desk. On SaaS it sits in our cloud, in your account — that's the feature. On the enterprise rungs it moves into the customer's building: their Postgres.

The **data path** rule ties it together: your live traffic goes straight to your room, never through the reception desk. Northflank's "real vs fake BYOC" test (verified): *"Can the vendor see the payload of a request to your application?"* If the vendor's servers terminate your traffic before forwarding it, it isn't really BYOC — it's single-tenant SaaS wearing a costume. One honest nuance for Zeros (2026-07-02): on our SaaS rung we *do* permanently store your chats — in the record, in your account, encrypted, exportable, deletable. That's the product, stated openly, not a leak. The enterprise rungs exist precisely so the whole answer becomes "no": the record, the bucket, and optionally the sandboxes themselves, all on their side.

Two more patterns auditors love (verified — Nuon, Redpanda, Depot docs):

- **Outbound-only agents**: a small vendor-supplied program inside the customer's account *calls out* to the control plane for instructions. The vendor never holds standing inbound access or stored credentials — like a valet who comes when paged rather than keeping a copy of your house keys.
- **Data-plane atomicity** (Redpanda's term): the workspace must keep working even if the vendor's control plane is down. Reception desk on fire; hotel rooms unaffected.

## How the grown-ups do it

Quick tour of the companies whose playbooks Zeros should crib from (all verified on official sources unless marked):

- **Coder** — the closest analog to Zeros' category (cloud dev environments, now pitched as "run AI coding agents on YOUR infrastructure"). Full self-host, open core: customers run the entire control plane themselves; basic OIDC SSO is *free*; Coder monetizes **governance** — audit logs, RBAC, multi-org, HA — in a custom-priced Premium tier. Lesson: for security-sensitive orgs running agents, *self-hosting is the product*, and governance features are the paywall.
- **Sourcegraph** — the pivot story above. Mechanics: Docker packaging, Kubernetes for big customers, a monthly release cadence, heavy upgrade documentation. In 2022 they added single-tenant *vendor-hosted* Cloud too — mature vendors end up offering the whole ladder.
- **GitLab self-managed** — the pricing benchmark: **the same $29/user/mo whether SaaS or self-managed**. Self-hosting saves the customer nothing on license; they pay for control, not a discount.
- **Retool** — the best small-team playbook. One Docker image + docker-compose; first customer deployed on an EC2 instance "three days later"; a simple license check-in endpoint; and the killer decision — **100% code reuse**: the same on-prem image runs their multi-tenant cloud. Result: security reviews shrank from ~30 days to ~5, and they scaled "a few million in ARR with 4 people." Their admitted costs: permanent version fragmentation and debugging inside other people's infrastructure.
- **Temporal** — control/data split by *design*: even on their SaaS, customer code runs on customer-operated "Workers," so application data can stay home. Notably, their self-hosted OSS ships *without* RBAC and audit logs — governance stays in the paid cloud. Enterprise features are the business, not the core function.
- **Northflank** — BYOC as the whole product: self-serve into AWS/GCP/Azure/on-prem, control plane stays hosted, **no markup on the customer's compute**, full feature parity, enterprise tier adds SSO/RBAC/audit/SLA.
- **Depot** — the minimal-viable BYOC for a tiny team: an open-source agent running in the customer's AWS account with an IAM role that can only touch resources tagged `depot-connection`, Terraform to set it up, and the client talking **directly over mTLS** to the customer-side machines so "build data never passes through Depot infrastructure." No Kubernetes required. This is the pattern a seed-stage Zeros could actually ship.
- **E2B** — the direct sandbox comp: enterprise-only BYOC via Terraform into a dedicated customer AWS/GCP account; templates, snapshots, logs, and all sandbox traffic stay in the customer VPC; only "anonymized system metrics" go home. The documented template for what a sandbox vendor's BYOC should look like.

## The lucky part: Zeros is already shaped like this

Here's the section that should make you smile. Grade the architecture — the June engineering plan (v2, 2026-06-24) plus the 2026-07-02 cloud-record decision, which the June plan predates — against the "real BYOC" test:

1. **All durable data now lives in ONE well-defined place.** The engine and the working copy — code checkout, chat, sessions, zeros.db — live inside the sandbox. **Updated 2026-07-02:** the June plan said durability = git remote + export blobs, with deliberately *no* always-live cloud database holding customer content; the founder has since decided the opposite — the permanent home of chats and history is now **the cloud record** (one Postgres schema), plus one storage bucket, plus git (exports remain only as a cheap backup safety net). For enterprise this is *better*, not worse: **because all durable data = one Postgres schema, self-hosting = pointing Zeros at their database.**
2. **The vendor is out of the live data path.** The Mac dials the sandbox *directly* over "the live wire" — a secure WebSocket (a persistent encrypted connection) with a per-user token. No Zeros broker sits in the middle — a deliberate divergence from Conductor, which routes everything through api.conductor.build. Zeros passes Northflank's payload test on the live path **today — and now by design, not accident**. (Verified.) The 2026-07-02 nuance is about *storage*, not traffic: on SaaS, the record in our cloud does permanently hold chats — that's the feature; on the enterprise rungs the record is their Postgres, so we hold nothing.
3. **The reception desk is thin and metadata-only — and stays that way.** Supabase auth + a `cloud_workspaces` registry + a small worker that holds the Daytona API key for provisioning. No code, and the desk itself holds no chat. **Updated 2026-07-02:** our cloud as a whole is no longer content-free — sitting next to the desk is the record, a separate, well-defined Postgres schema that *does* permanently hold chats and history for SaaS customers. That is the feature, stated openly; enterprise is the escape hatch. The discipline changes shape: keep the desk thin, and keep the record behind the upgraded **seam #1 — a configurable record endpoint**: the record's database URL is config, never hard-coded, so pointing it at a customer's Postgres is a config change, not a rewrite.
4. **The sandbox vendor is behind a seam.** The `CloudSandboxProvider` interface exists precisely because Daytona went closed-source on 2026-06-11; Fly.io is the named fallback. The same seam is the enterprise door: "provision into the customer's infrastructure" is just another implementation.
5. **The engine runs on plain Linux.** No proprietary cloud primitives (no Lambda, no BigQuery) in the data plane — SQLite, git, containers. Replicated calls cloud-primitive lock-in *the one unforgivable early mistake* because it later blocks regulated, government, and Fortune-500 deals. Zeros doesn't have it.

So what does "enterprise Zeros" concretely look like? In every flavor the anchor is the same (decided 2026-07-02): **their Postgres (the record) + their object storage + optionally their sandbox runners**, delivered as Docker Compose/Helm plus a license key. The flavors differ only in who runs the sandboxes and the reception desk — three, in order of likelihood:

- **BYOC via Daytona custom regions** (nearest-term): the record and the backup bucket go on the customer's Postgres and storage; for the runners, Daytona already supports customers running "runner" machines in their own VPC or on-prem, connected to Daytona's SaaS control plane, deployed via Helm on Kubernetes, with *no concurrency limits*. Caveats: it's sales-gated, early, and the Daytona control plane itself is never self-hosted — so the truly paranoid buyer still sees a Daytona dependency. (Verified docs exist; GA status unverified — ask Daytona sales directly before leaning on it.)
- **BYOC via our own provider implementation** (the Depot pattern): the same customer-side record and bucket, plus a `CloudSandboxProvider` that provisions plain VMs or containers in the customer's AWS account through a tag-scoped IAM role, with the Mac still connecting directly over WSS. More work, zero third-party dependency in the customer's boundary.
- **Full self-host** (later, contract-funded): ship the engine image + the reception desk (registry/auth) as Docker Compose/Helm + a license key, everything pointed at their own Postgres and storage — realistic only because the engine already runs on plain Linux and the record endpoint is config (seam #1), but a real support commitment (see risks).

The one-sentence enterprise pitch this architecture earns, on rungs 2–3: **"Your agents, your code, your chat run in your cloud; we only orchestrate."** Since 2026-07-02 that sentence is *literally* true on the enterprise rungs, chat included — the record itself runs on their Postgres. (On the SaaS rung, sell the other honest sentence instead: "your work is always in your account — encrypted, exportable, deletable.") Cursor structurally cannot say the enterprise sentence. Conductor, whose backend brokers all cloud-workspace traffic through their Fly-hosted API, currently can't either.

## What exists today vs what must be built

| Capability | Status as of July 2026 |
|---|---|
| Self-contained engine + working copy in the sandbox | **Exists** (verified in code — engine honors `ZEROS_DATA_DIR`). Updated 2026-07-02: zeros.db is now the *working* copy — the permanent home is the cloud record (next two rows) |
| The cloud record (chats/sessions/history in cloud Postgres) + engine write-through & restore | **Decided 2026-07-02 — must be built**: the record schema lands with Phase 4; write-through & restore is the re-scoped Phase 7 (see part 07) |
| Configurable record endpoint — seam #1: the record's DB URL is config, never hard-coded | **Must be designed in now** (costs ~nothing) — it is what makes "self-hosting = pointing Zeros at their database" literally true |
| Direct client↔sandbox connection, vendor out of live data path | **Designed & partially built** (Phase 1 built & merged 2026-06-25; its exit run awaits a Daytona API key — needs-testing) |
| Swappable sandbox provider interface | **Exists as a seam**; only the Daytona implementation is underway |
| Thin, metadata-only reception desk (auth + registry + worker) | **Designed** (Phase 4, not yet built) — Phase 4 now also carries the record schema alongside it; the desk itself stays metadata-only |
| Teams as first-class in the data model | **Must be designed in now** — WorkOS: retrofitting a tenant layer later is "a months-long migration that touches every table" |
| SAML SSO / SCIM / audit logs | **Must be bought** (WorkOS-style, ~$125/connection/mo) when the first enterprise appears |
| Audit logging of *agent* actions | **Must be built** — WorkOS's 2026 checklist now calls out agent/MCP auth and per-call audit; uniquely relevant to an agent product |
| SOC 2 Type II | **Must be done** — a quarter-scale project with Vanta/Drata tooling; PostHog did it small |
| Terraform/Helm packaging for customer accounts | **Must be built** (Phase-2-of-enterprise work, or bought via Replicated/Nuon/Distr) |
| License keys, support bundles, telemetry switch | **Must be built** — small pieces; the telemetry switch and a one-line data-flow statement cost nothing now |

## What people charge (so you don't undercharge)

Anchors from the notes, all as of mid-2026:

- **Same seat price, either deployment**: GitHub Enterprise **$21/user/mo** covers Cloud *and* self-hosted Server; GitLab Premium **$29/user/mo** either way. The cleanest model: self-host is a deployment option, not a discount. (Verified.)
- **Self-host/BYOC gated to a custom enterprise tier**: the dominant dev-tool pattern (Retool, Coder, Airbyte). Deals typically start **$20k–$100k+/yr**. (Verified pattern; figures likely.)
- **BYOC with no infra markup**: Northflank charges the same rates in your VPC as in theirs — the customer's cloud bill absorbs compute; the vendor monetizes the control plane and support. (Verified.)
- **Single-tenant hosted is the expensive rung**: GitLab Dedicated ≈ **$26k/month floor**, a 20–35% premium over SaaS. (Likely — benchmark data.)
- **Governance is the paywall**: Coder and Temporal both give away the core and charge for audit/RBAC/HA. For Zeros, the analog is: cloud workspaces broadly available; SAML+SCIM+audit+BYOC in a Business/Enterprise tier. One nuance from the "SSO tax" backlash: consider keeping basic OIDC SSO cheap (Coder does; CISA recommends it), and paywall SAML+SCIM+audit instead.

## Table stakes: the checklist buyers grade you on

From the WorkOS 2026 enterprise-readiness checklist + EnterpriseReady (verified), in priority order:

1. **SSO** — SAML 2.0 + OIDC, per-organization config. "SSO is the chokepoint that makes governance possible" for AI tools.
2. **Team-first data model** — the single most important *early* design decision on the list.
3. **SCIM / directory sync** — with *real-time deprovisioning* (offboarding is the buyer's actual fear).
4. **RBAC** — and for agents, the safe default: an agent inherits exactly its user's permissions, no more.
5. **Audit logs** — append-only, 1+ year retention, streamable to the customer's security tools. "Procurement will ask for your audit log before they ask about your pricing." Must capture **agent actions**, not just human ones.
6. **MFA + a self-serve admin portal** (domain verification, SAML-cert health).
7. **SOC 2 Type II** (the entry ticket), then ISO 27001; DPAs and a ZDR posture with model providers on request.
8. **Private networking options** (PrivateLink/VPC peering) — often the concession that *avoids* self-hosting.
9. **MCP/agent auth** — new for 2026; likely in security questionnaires for agent products within a year.

## The risks (why not to rush)

- **Support burden**: PostHog killed its Kubernetes self-hosted product in May 2023 — only **3.5% of users** ran it, yet it overwhelmed a small infra team with failures across Kafka/ClickHouse/Postgres/Redis; a full disk could down a customer "for hours or days." (Verified — their own post-mortem.) The strongest single argument against building self-host before paying demand exists.
- **Version skew**: Retool admits "many versions of Retool in use at any given time" — you can't force upgrades on customer-run software, so every old version is a support liability forever.
- **Over-packaging**: Replicated's #1 mistake list — shipping your SaaS topology (service meshes, GitOps stacks) as the customer package. Ship one Docker image first; Helm only when a customer's platform team demands it.
- **Air-gap gravity**: offline bundles, in-cluster registries, file-drop updates, and support loops measured in days. Defense/gov only. Defer indefinitely.
- **Daytona dependency in the BYOC story**: their custom regions keep the control plane as Daytona SaaS, and the whole feature is sales-gated and early. Don't let the enterprise roadmap assume it exists at GA quality — verify with Daytona directly (needs-testing).

## The phased plan

**Phase 0 — now, during v1 (costs ~nothing):** design the seams, build no enterprise features.
1. **Seam #1 (upgraded 2026-07-02): make the record endpoint configurable.** The record's database URL — and the backup bucket's — is config, never hard-coded. This one rule is what keeps "self-hosting = pointing Zeros at their database" true.
2. Make **teams first-class** in the Supabase schema when Phase 4 (control plane + record schema) is built — memberships and workspaces hang off a team from day one.
3. Keep the reception desk **metadata-only** — no code, no chat *in the desk itself*. (Updated 2026-07-02: chats now do live in our cloud for SaaS customers — but in the record, one separate, well-defined Postgres schema, never scattered into the desk.)
4. Keep the **engine image portable** (Retool's 100%-reuse rule): the image that runs in Daytona is the image a customer could someday run in their VPC. No hard-coded vendor URLs anywhere (the plan already warns: never hardcode the preview-proxy apex).
5. Preserve **direct client↔sandbox connections** ("the live wire") as features land — resist any convenience broker.
6. Add a **telemetry on/off switch** and write the one-line data-flow statement ("what leaves the workspace, to whom"). It's the first security-questionnaire answer later.

**Phase 1 — first enterprise interest (~first 5–20 team customers):** buy, don't build. WorkOS-style SAML SSO + SCIM + audit streaming (~$1–3k/mo total); SOC 2 Type II; DPA template + subprocessor list + ZDR posture with model providers (the Cursor playbook — for many buyers this *substitutes* for self-hosting entirely).

**Phase 2 — real "our servers" demand with money attached:** ship **BYOC before self-host** — and within BYOC, the record first: their Postgres + their object storage is the cheapest rung to deliver, because the record endpoint is already config (seam #1). Then, if they want compute in-house too, their sandbox runners: Depot's pattern (Terraform + scoped IAM/outbound agent + direct WSS from the Mac to customer-side sandboxes) or Daytona custom regions if they've matured. Package as Docker Compose/Helm + a license key. Gate to enterprise tier at $30–100k+/yr. Or buy the machinery (Replicated, Nuon, Distr exist precisely so startups don't build this). Full self-host of the control plane only when a specific contract pays for it. Air-gap: not this company, not this decade of the company.

## What this means for Zeros

1. **Build nothing enterprise-specific before v1 GA.** Every credible source — PostHog's shutdown, Replicated's mistakes list, Railway's "one-sentence justification" test — says the same thing. Ship the single-user cloud workspace first.
2. **But lock in the four enterprise seams now (updated 2026-07-02)**: a **configurable record endpoint** (seam #1 — the record's DB URL is config, never hard-coded; upgraded from the June plan's softer "keep the data exportable" idea); the swappable `CloudSandboxProvider`; no hard-coded vendor URLs in one portable engine image; an engine that runs on plain Linux. Keep the older disciplines alongside: team-first schema in Phase 4, a reception desk that stays metadata-only, direct connections with Zeros off the live path. Together these are the difference between "enterprise is a config change plus a provider implementation" and "enterprise is a rewrite."
3. **Treat the auth stack as a line item, not a roadmap item.** SAML/SCIM/audit ≈ $125/connection/month from WorkOS-class vendors. Budget it into enterprise pricing; never hand-build it.
4. **Ask Daytona sales two questions before GA** (an email, not a project): what does customer-managed compute concretely look like today, and what's the GA timeline for custom regions? Their answer determines whether the first enterprise deal is "Daytona BYOC" or "our own provider on plain VMs."
5. **Sell two honest sentences.** To SaaS customers: "your work is always in your account" — the record, encrypted, exportable, deletable. To enterprises, on rungs 2–3: "your agents, your code, your chat run in your cloud; we only orchestrate" — literally true since 2026-07-02, because the record itself moves to their Postgres. Cursor offers no self-host at all, and Conductor brokers cloud traffic through its own backend; neither can say the second sentence. Zeros' architecture earns it — the job is to keep seam #1 alive so it stays a config change.
6. **Price the ladder the standard way**: same product everywhere; SAML+SCIM+audit+BYOC in a custom enterprise tier starting ~$30k/yr; no markup on customer compute in BYOC; single-tenant hosted only if someone begs (and then at a GitLab-Dedicated-style premium).

## Sources

- https://www.enterpriseready.io/features/deployment-options/ — the canonical deployment-spectrum guide (packaging, licensing, private instances)
- https://northflank.com/blog/what-is-byoc-in-cloud-computing — BYOC definition, three-layer architecture, real-vs-fake test
- https://blog.railway.com/p/what-is-byoc-developer-guide-2026 — Railway's "one-sentence justification" test; Railway is not a BYOC platform
- https://nuon.co/blog/byoc-control-plane-data-plane-architectures — agent-based/outbound-only BYOC mechanics
- https://coder.com/pricing and https://coder.com/docs/about — Coder's open-core self-host model, free OIDC SSO, paid governance
- https://webflow.sourcegraph.com/blog/from-saas-to-on-premises — Sourcegraph's 2017 SaaS→on-prem pivot
- https://about.gitlab.com/pricing/ and https://about.gitlab.com/dedicated/ — GitLab same-price self-managed; Dedicated single-tenant SaaS
- https://docs.github.com/en/enterprise-server@3.15/get-started/learning-about-github/githubs-plans — GitHub Enterprise unified $21/user licensing
- https://retool.com/blog/building-a-modern-on-prem-software-business — Retool's on-prem playbook (100% code reuse, license check-in, 30→5-day security reviews)
- https://docs.temporal.io/evaluate/development-production-features/cloud-vs-self-hosted-features — Temporal's cloud-vs-self-host governance split
- https://northflank.com/pricing — BYOC with no compute markup, enterprise feature gating
- https://depot.dev/docs/self-hosted/architecture — Depot's minimal small-team BYOC (tag-scoped IAM, direct mTLS)
- https://e2b.dev/docs/byoc — E2B's enterprise BYOC into customer AWS/GCP
- https://cursor.com/enterprise and https://cursor.com/docs/enterprise/privacy-and-data-governance — Cursor's no-self-host, ZDR-instead posture
- https://workos.com/blog/enterprise-readiness-checklist-2026 — the enterprise table-stakes checklist (incl. agent/MCP auth)
- https://workos.com/pricing — SSO/SCIM/audit-streaming pricing (~$125/connection/mo)
- https://sso.tax/ — the SSO-tax debate (context for tiering decisions)
- https://posthog.com/blog/sunsetting-helm-support-posthog — PostHog's self-host shutdown post-mortem (the key cautionary tale)
- https://www.replicated.com/blog/avoiding-the-biggest-mistakes-in-on-prem-software-delivery — top on-prem delivery mistakes (cloud-primitive lock-in warning)
- https://docs.replicated.com/enterprise/installing-embedded-air-gap — air-gap bundle mechanics
- https://www.daytona.io/docs/en/bring-your-own-compute and https://www.daytona.io/docs/en/regions/ — Daytona custom regions / BYOC runners, dedicated regions
- https://www.daytona.io/dotfiles/daytona-is-going-closed-source — Daytona's 2026-06-11 closed-source announcement (why the provider seam matters)
- [08-engineering-reference.md](08-engineering-reference.md) (internal — the v3 consolidation, 2026-07-03, of the June plan v2 2026-06-24; original removed) — Zeros two-plane architecture, thin control plane, `CloudSandboxProvider` seam, phase status. The June v2 still described durability as git + export blobs; the v3 applies the 2026-07-02 cloud-record decision — part 07 lists what changed
