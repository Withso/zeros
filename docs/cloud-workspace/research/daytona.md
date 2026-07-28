# Daytona (daytona.io) — state, pricing, enterprise options

Research date: 2026-07-02. Confidence marks: **[verified]** = confirmed on official Daytona pages/registries or 2+ independent sources; **[likely]** = single credible source or strong indirect evidence; **[unverified]** = claim seen but not corroborated.

## TL;DR

- Daytona is a venture-backed (~$31M raised, Series A Feb 2026) sandbox-infrastructure company that went **closed source on 2026-06-11**, citing AI-driven vulnerability discovery. The SDKs stay open (Apache-2.0) and ship weekly; the platform itself is now proprietary SaaS.
- Pricing is usage-based: **$0.0504/vCPU-hr (Linux)**, **$0.0162/GiB RAM-hr**, **$0.000108/GiB disk-hr**, $200 free credit, no credit card required. Tier system T1–T4 gates resource pools and egress.
- **Stopped sandboxes bill disk only; archived sandboxes move to object storage (cheaper) — recommended path to "eliminate disk usage costs."**
- Shared regions today: **US and EU only** (per current docs). A May-2025 announcement listed Mumbai, but Asia is absent from the current regions doc.
- Preview URLs proxy **HTTP and WebSocket** traffic (per architecture docs), with per-sandbox tokens and signed URLs — the mechanism Zeros' plan relies on works, with caveats about the warning page below Tier 3.
- Fork (copy-on-write) and live/memory snapshots exist but are **explicitly `_experimental_`** in the SDK (shipped April 2026); Vercel's filesystem snapshots went **GA Jan 30, 2026**.
- Enterprise: SSO, audit logs, custom limits, **dedicated regions** (Daytona-managed exclusive infra) and **BYOC "custom regions"** — customer runs runner nodes in their own VPC/on-prem, Daytona keeps the control plane as SaaS. BYOC is documented but signals say invite-only/experimental; there is **no self-hosted control plane** offering anymore.
- Compliance: SOC 2 **Type I achieved**, Type II **in progress**, HIPAA BAA available, ISO 27001 in progress. Isolation for Linux container sandboxes is **Sysbox (shared host kernel, user-namespaced)**; Linux VM and Windows VM sandbox classes exist for hardware-level isolation.

---

## 1. Company snapshot & health

- Legal entity: **Daytona Platforms Inc.**; Croatian-founded (CEO Ivan Burazin), pivoted from open-source dev-environment manager to AI-agent sandboxes in early 2025. **[verified]**
- Funding history **[verified]**:
  - Pre-seed ~$2M; **$5M seed June 2024** led by Upfront Ventures (500 Global participating).
  - **$24M Series A announced 2026-02-05**, led by FirstMark Capital; Pace Capital, Upfront, Darkmode, E2VC; strategic checks from **Datadog and Figma Ventures**; angels incl. Nikita Shamgunov (Neon), Theo Browne, Eno Reyes (Factory.ai). Total raised ≈ **$31M** (Tracxn).
  - Valuation **$125M** reported (The Information via Stephanie Palazzolo/LinkedIn). **[likely — single reporting chain]**
- Traction (from Daytona's own Series A post, 2026-02-05): "$1M forward revenue run rate in under three months, doubled six weeks later"; named customers **LangChain, Turing, Writer, SambaNova**. **[verified as company claim]**
- Reliability: status page (status.app.daytona.io, checked 2026-07-02) shows **99.988% uptime** for app.daytona.io API and **99.983%** for sandbox creation; 2026 incidents: 15-min outage May 1, 6-min sandbox-creation degradation June 10, ~35-min "Degraded Runners" June 26–27. **[verified]**
- No acquisition/sale reports found; one competitor tweet speculated the closed-source move was "for sale reasons" — pure speculation. **[unverified]**
- Risk signals for a dependency decision: Series A-stage vendor; closed source removes the fork-and-run escape hatch (frozen AGPL repo is the only fallback); very fast ship cadence (weekly platform releases v0.132→v0.19x Jan–Jun 2026) means APIs move quickly and some load-bearing features (fork, live snapshots, BYOC) are still experimental.

## 2. The closed-source move (2026-06-11)

- Official post: "Daytona is going closed source. Here's why." dated **June 11, 2026**. Production codebase moved to a private repo. Stated reason is **security only**: "AI can now be pointed at an open source repository and systematically search it for exploitable flaws, at a speed and scale no human team can match." Cites AI finding "all twelve zero-day vulnerabilities in a single OpenSSL release" and Google threat-intel reporting an AI-assisted exploit used in the wild. **[verified]**
- Core quote: "A single isolation escape is not an inconvenience for us. It is a breach of the one promise the platform exists to keep."
- The old repo **github.com/daytonaio/daytona** (72,322 stars) is frozen: README now says "This repository is no longer maintained… no further updates, fixes, or releases. It remains public and free to use, fork, and build on under the LICENSE" — that license is **AGPL-3.0** (checked at tag v0.190.0). The LICENSE file was removed from `main`. **[verified via GitHub API + raw files, 2026-07-02]**
- Open assets moved to a new org, **github.com/daytona**: `clients` (SDKs/API clients/CLI/MCP — Apache-2.0 with `cli/` under AGPL-3.0), `skills` (Apache-2.0), `integrations` (Apache-2.0), `guides` (MIT). **[verified via GitHub API]**
- Daytona commits to "publishing information about isolation models, security guarantees, and incident responses" and says "If the threat landscape shifts in a way that makes openness defensible again, we want to revisit it." **[verified]**
- Community reaction: competitor E2B called out as "now the only serious open source sandbox" (Ben Swerdlow tweet); general OSS-retrenchment commentary. No large HN thread found on the move itself. **[verified tweets exist]**

## 3. SDK health

- npm package renamed **@daytonaio/sdk → @daytona/sdk** (same API, no breaking changes); license **Apache-2.0**. **[verified via npm registry]**
- Release cadence is healthy post-closed-source (registry checked 2026-07-02): 0.187.0 (Jun 11), 0.189.0 (Jun 19), 0.190.0/0.190.1 (Jun 23), 0.191.0 (Jun 25), **0.192.0 latest (Jun 26)**, 0.193.0-alpha.1 (Jun 29). Roughly 2–3 releases/week. **[verified]**
- SDK languages: **TypeScript, Python, Go, Java, Ruby** (all received fork/snapshot support Apr 2026). **[verified]**
- Old `daytonaio/sdk` GitHub repo is archived; new home is `daytona/clients` (actively pushed, last push 2026-07-01). **[verified]**

## 4. Pricing (official pricing page, checked 2026-07-02) — all [verified] unless noted

| Resource | Price |
|---|---|
| vCPU (Linux) | **$0.0504 / hour** |
| vCPU (Windows) | **$0.0858 / hour** |
| Memory | **$0.0162 / GiB-hour** |
| Storage/disk | **$0.000108 / GiB-hour**, "price per GiB after first 5 free" |
| GPU — Nvidia H100 | $3.95 / hour |
| GPU — Nvidia RTX PRO 6000 | $3.03 / hour |

- **$200 free compute credit** on signup, no credit card required. **[verified]**
- Per-second metering equivalents ($0.000014/s vCPU, $0.0000045/s GiB RAM, $0.00000003/s GiB storage) reported by Blaxel's pricing comparison; consistent with the hourly rates. **[likely — secondary source]**
- Billing mechanics (docs/en/billing): pay-as-you-go against a prepaid **wallet** (balance in USD); one-time top-ups; **automatic top-up** rules (threshold + target); coupon codes; **up to 48-hour delay** between consumption and charges appearing (charges in that window post-cancellation still owed); auto-generated invoices. **[verified]**
- Metering units: CPU in seconds, RAM in GB-seconds, disk in GB-seconds. **[verified]**
- Example cost feel: a 2 vCPU / 4 GiB sandbox running ≈ $0.166/hr ≈ $4/day if never stopped — auto-stop (below) is the main cost lever.

### What bills in each lifecycle state

- **Running**: CPU + RAM + disk. **[verified]**
- **Stopped**: memory cleared, filesystem persists — "incur only disk usage costs." **[verified, sandboxes docs]**
- **Archived**: "entire filesystem state is moved to cost-effective object storage"; docs recommend stop→archive "to eliminate disk usage costs." Exact archived $/GiB not published. **[verified mechanics; price unpublished]**
- Daytona does not publish restore-latency numbers for archived→started. **[verified absence]**

## 5. Tier system T1–T4 (docs/en/limits, checked 2026-07-02) — [verified]

Limits apply to the organization's **default region** and are pooled across all running sandboxes (concurrent sandbox count = whatever fits in the pool).

| Tier | Unlock requirement | vCPU pool | RAM pool | Disk pool | API req/min | Sandbox creates/min |
|---|---|---|---|---|---|---|
| T1 | Email verified | 10 | 20 GiB | 30 GiB | 10,000 | 300 |
| T2 | Credit card + $25 top-up | 100 | 200 GiB | 300 GiB | 20,000 | 400 |
| T3 | $500 top-up | 250 | 500 GiB | 2,000 GiB | 40,000 | 500 |
| T4 | $2,000 top-up every 30 days | 500 | 1,000 GiB | 5,000 GiB | 50,000 | 600 |
| Enterprise | Contact support@daytona.io | custom | custom | custom | custom | custom |

- Per-sandbox defaults: **1 vCPU / 1 GB RAM / 3 GiB disk**; per-sandbox org maximum **4 vCPU / 8 GB RAM / 10 GB disk** (larger = enterprise/custom). Relevant to Zeros: a full engine + agent + build tooling may bump against 4 vCPU/8GB — check fit or plan on custom limits. **[verified]**
- April 21, 2026 changelog added **per-region resource limits**. **[likely — search snippet of changelog]**

## 6. Startup Grid (daytona.io/startups) — [verified]

- **$10K credits on acceptance**, "no strings attached"; scalable path to **$50K** as the startup grows.
- Referrals from partner VCs/accelerators: **$25K** with pathway to an **additional $50K**.
- Application: form + pitch-deck link + 100-word story; "less than 5 minutes."
- Also markets direct access to Daytona's engineering team for implementation support.

## 7. Regions — [verified with one discrepancy]

- Current docs (docs/en/regions): **two shared regions — `us` and `eu`** — managed by Daytona, available to all orgs. Selected via `target` parameter in SDK. Access to regions other than your org's default requires **contacting sales@daytona.io**.
- Discrepancy: a May 1, 2025 blog announced 5 regions (US-East Washington DC, US-West Oregon, EU-Central Frankfurt, EU-West London, **Asia-South Mumbai**) "available now for all users", default us-east. The current docs list only US/EU shared regions — **no shared Asia region today**; Mumbai appears to have been dropped or folded into non-shared offerings. **[verified discrepancy; current state = us/eu]**
- **Dedicated regions**: exclusive Daytona-managed infrastructure for one org; contact sales@daytona.io. **[verified]**
- **Custom regions (BYOC)**: org-run runner machines; "custom regions have no limits applied for concurrent resource usage." See §11. **[verified]**
- Jan 18, 2026 platform release (v0.132.0) added job-based runners (v2) and per-region SSH gateway/proxy support — the plumbing behind custom regions. **[verified changelog]**

## 8. Network limits / egress allowlist (docs/en/network-limits) — [verified]

- **Tier 1 & 2: egress is restricted and cannot be overridden at the sandbox level** — org restriction wins even if `networkAllowList`/`domainAllowList` is passed at creation.
- **Tier 3 & 4: full internet by default** + per-sandbox controls, and can modify network settings on *running* sandboxes via `updateNetworkSettings()` without restart.
- Default allowlist (all tiers) covers: package managers (npm, PyPI, Maven, Composer, Bun), VCS (GitHub, GitLab, Bitbucket, Azure DevOps), container registries (Docker Hub, GCR, Quay, k8s registry), OS repos (Ubuntu/Debian), CDNs (Cloudflare, Fastly, jsDelivr, unpkg), **AI APIs (OpenAI, Anthropic, Google AI, Groq, DeepSeek, etc.)**, cloud storage (select S3 regions, GCS), dev tools (Vercel, **Supabase**, Clerk, Sentry, PostHog, Linear, Figma, Playwright), Google Fonts, Telegram API.
  - Zeros note: agents doing `git push` to GitHub + hitting Anthropic APIs work even at T1/T2; arbitrary customer endpoints (private registries, self-hosted git, arbitrary webhooks) need **T3+**.
- Per-sandbox settings (mutually exclusive): `networkBlockAll: true`; `networkAllowList` (max **10** IPv4 CIDR entries); `domainAllowList` (max **20** domains, wildcards allowed).

## 9. Preview URLs & WebSocket (WSS) proxying

- URL formats **[verified]**: standard `https://{port}-{sandboxId}.{proxyDomain}` and signed `https://{port}-{token}.{proxyDomain}`; docs example domain `proxy.daytona.work`. Any port **1–65535**.
- Auth **[verified]**:
  - Standard URLs: `x-daytona-preview-token` header; token **resets when the sandbox restarts** (previously issued standard tokens invalidated).
  - **Signed URLs**: auth embedded in URL; expiry configurable **1s–86,400s (24h), default 60s**; persist across restarts until expiry or `expire_signed_preview_url()` revocation.
  - `public: true` sandboxes need no auth.
- **WebSocket**: architecture docs state the proxy "forwards requests supporting both HTTP and WebSocket protocols" **[verified]**; custom-preview-proxy docs: "WebSocket upgrade requests (`Upgrade: websocket`) are automatically detected and proxied. WebSocket connections skip the preview warning page." **[verified for the proxy pipeline; the main preview doc page itself doesn't mention WS]** → Zeros' preview-URL-WSS + per-user-token design is supported; browsers' first *HTTP* visit sees a warning page unless bypassed.
- Warning page on first browser visit; bypass via `X-Daytona-Skip-Preview-Warning: true` header, **upgrading to Tier 3**, or a custom preview proxy. **[verified]**
- **Custom preview proxy** (docs/en/custom-preview-proxy): run your own proxy in front (custom domain, own auth, custom error/starting pages); forward `X-Forwarded-Host`; control headers incl. `X-Daytona-Preview-Token`, `X-Daytona-Disable-CORS`, `X-Daytona-Skip-Last-Activity-Update`. **[verified]**
- Preview/API/SSH traffic counts as activity and resets the auto-stop timer (see §10). **[verified]**

## 10. Sandbox lifecycle: stop / archive / restore semantics — [verified, docs/en/sandboxes]

- States include: creating → pulling/building snapshot → **started** → **stopped** → **archived** → destroyed/**deleted**; plus **paused** (VM sandboxes only — preserves filesystem *and memory*) and error (with `recoverable` flag).
- **Auto-stop**: default **15 minutes** of inactivity; `0` disables. Timer resets **only** on: API requests to the sandbox, SSH connections, preview-URL network traffic.
- **Auto-archive**: default **7 days** continuously stopped; `0` = maximum interval **30 days**.
- **Auto-delete**: off by default (interval not set); `autoDeleteInterval: 0` = **ephemeral** (deletes on stop). GPU sandboxes are forced ephemeral.
- Archive = filesystem moved to object storage; stopped = filesystem on disk (billed), memory cleared.
- Snapshots auto-deactivate after **2 weeks** unused; inactive snapshots must be re-activated before use.

## 11. Enterprise / self-hosted / BYOC — CRITICAL SECTION

What Daytona sells to enterprises (pricing page + docs, 2026-07-02):

1. **Enterprise tier** (contact sales): "Designed for businesses that need larger limits, SSO, audit logs, or BYOC." Custom resource limits via support@daytona.io. Audit logs + secrets management are documented product features. **[verified]**
2. **Dedicated regions**: Daytona-managed, single-tenant infrastructure ("exclusive infrastructure through dedicated regions managed by Daytona"), via sales@daytona.io. This is the "dedicated deployment" option — Daytona still operates it. **[verified]**
3. **BYOC / Customer-managed compute ("custom regions" + runners)** — the answer to "can a customer run Daytona runners in their own VPC/on-prem?" is **yes, architecturally**:
   - Docs (docs/en/bring-your-own-compute): "Bring Your Own Compute enables you to run sandbox workloads on your own infrastructure while using Daytona's control plane to manage them." **[verified]**
   - Mechanics: org creates a **custom region** in the dashboard, provisions **runner nodes** on its own cloud/on-prem; runners authenticate to Daytona's SaaS control plane with a **one-time API token** ("You won't be able to see it again"); connectivity via **reverse-proxy tunnels**; deployment example is **Helm charts on AWS EKS**. Optional customer-side components: region-specific proxy and snapshot manager. **[verified]**
   - Benefits per docs: "maximum control over data locality, compliance, and infrastructure configuration"; **no concurrent resource-usage limits** in custom regions. **[verified]**
   - Caveats: the **control plane remains Daytona SaaS** — this is not self-hosting; customer owns compute nodes, scaling, and networking ops (Northflank's analysis: "Daytona does not manage orchestration inside your environment"). Access signals conflict: regions docs previously said custom regions are "invite-only experimental — contact support@daytona.io," and Northflank (2026) calls it "experimental… not publicly documented or self-serve," while the BYOC docs page is now live without an explicit experimental banner. Treat as **early/limited-availability, sales-gated**. **[verified docs exist; GA status unverified]**
   - Pricing for BYOC not published. **[verified absence]**
4. **Fully self-hosted control plane: not offered.** Before 2026-06-11 you could self-host from the AGPL-3.0 repo; that repo is frozen at v0.190.0 with no maintenance, so self-hosting is now a dead-end fork path. **[verified]**

## 12. Isolation model — [verified via Daytona Security Exhibit, docs/en/security-exhibit]

- Linux container sandboxes run on **Sysbox** ("The platform uses Sysbox as its runtime"): Linux **user-namespaces on all sandboxes** ("root user inside a sandbox maps to a fully unprivileged user on the host"), virtualized procfs/sysfs, immutable initial mounts, selective syscall interception. Exclusive UID/GID mappings per sandbox. This is **shared-host-kernel** isolation — stronger than plain Docker, weaker than a microVM boundary.
- Security exhibit hedges: "each sandbox using container and/or microVM technology."
- **VM sandbox classes now exist**: snapshot classes are Linux Container, **Linux VM**, **Windows** (VM); VM sandboxes support **pause** and **hot (memory) snapshots**. Windows compute is priced ($0.0858/vCPU-hr). VM availability/tier gating not fully documented. **[verified classes exist; availability details unverified]**
- Docker-in-Docker and k3s-in-sandbox supported (a Sysbox strength). **[verified]**
- Third-party analyses (pixeljets, SoftwareSeni, 2025–2026) describe optional Kata Containers/Cloud Hypervisor for max isolation. **[likely]**
- Encryption: TLS 1.2+ in transit, AES-256 at rest, provider KMS with rotation. Sub-90ms sandbox creation is the headline perf claim. **[verified as claims]**

## 13. Compliance — [verified]

- Trust center: **trust.daytona.io** (SafeBase), launched **2025-10-13**.
- **SOC 2 Type I: achieved.** **SOC 2 Type II: in progress** (per security exhibit, mid-2026). **ISO 27001: in progress.** **HIPAA BAA available** for qualifying customers. GDPR compliance claimed on marketing pages.
- Annual third-party penetration testing (platform, APIs, sandbox isolation, control plane). Vulnerability remediation SLAs: Critical 24h / High 7d / Medium 30d / Low 90d.
- "Daytona does not use Customer Content to train models or improve services."

## 14. Fork / snapshots maturity vs Vercel — [verified]

- Daytona timeline:
  - **2026-04-14 (v0.165.0)**: fork + snapshot **API endpoints**; copy-on-write forks of running sandboxes; dashboard fork-tree visualization + recursive delete.
  - **2026-04-15 (v0.166.0)**: SDK support in all 5 languages — methods are **explicitly experimental**: TS `_experimental_fork(params?, timeout=60)` and `_experimental_createSnapshot(name, timeout=60, includeMemory=false)`; `includeMemory` is **VM sandboxes only (Windows, Linux VM)**.
  - Hot snapshot = filesystem + memory (VM only, "running applications… instantly available on any new sandbox"); cold snapshot = filesystem only. Freestyle's analysis (May 20, 2026) confirms the live-snapshot API was still marked experimental. **[verified]**
- Vercel comparison: **Vercel Sandbox went GA on 2026-01-30** with filesystem snapshots as a GA feature; Vercel sandboxes are persistent-by-default (auto filesystem snapshot on stop). So: Vercel is ahead on *GA-stamped* filesystem snapshots; Daytona is ahead on *capability breadth* (CoW forks, memory/hot snapshots, fork trees) but ships them under experimental flags. **[verified]**

## 15. Zeros-specific implications (analyst notes)

- The engine-in-sandbox + preview-URL WSS + per-token design in docs/cloud-workspaces-daytona-execution-plan.md matches documented Daytona capabilities (ports 1–65535, signed URLs up to 24h, WS proxying). The two design frictions: **standard preview tokens reset on sandbox restart** (plan should re-fetch on reconnect), and signed-URL max expiry of 24h means token refresh plumbing either way.
- Cost model favors the plan's stop/archive lifecycle: idle workspaces at disk-only cost ($0.000108/GiB-hr → ~$0.08/GiB-month), archived at less; auto-stop 15-min default aligns with laptop-closed semantics, but note preview-URL traffic (i.e., an open WSS from another device) resets auto-stop — a persistent connection keeps the meter running.
- Default per-sandbox ceiling (4 vCPU/8GB/10GB) and T1 org pool (10 vCPU) are tight for "many parallel agents"; realistic usage lands at T2–T3 quickly ($25–$500 top-ups), which conveniently also unlocks unrestricted egress and warning-page bypass at T3.
- Vendor risk: closed source + Series A stage; mitigations Daytona itself offers are BYOC runners (sales-gated) and dedicated regions; the durability design in the Zeros plan (git remote + export blobs) is the right hedge since sandbox contents are re-creatable.

## Sources

- https://www.daytona.io/dotfiles/updates/daytona-is-going-closed-source (closed-source announcement, 2026-06-11)
- https://github.com/daytonaio/daytona (frozen repo, README + stars; LICENSE at tag v0.190.0 = AGPL-3.0)
- https://github.com/daytona (new org: clients/skills/integrations/guides, licenses via GitHub API)
- https://registry.npmjs.org/@daytona/sdk (npm metadata: Apache-2.0, versions/dates through 0.193.0-alpha.1, 2026-06-29)
- https://www.daytona.io/pricing (compute/GPU prices, $200 credit, Startup credits, Enterprise blurb)
- https://www.daytona.io/docs/en/limits/ (T1–T4 pools, rate limits, unlock requirements)
- https://www.daytona.io/docs/en/network-limits/ (egress tiers, default allowlist, per-sandbox network settings)
- https://www.daytona.io/docs/en/regions/ (shared us/eu, dedicated regions, custom regions)
- https://www.daytona.io/dotfiles/new-regions-available-ai-sandboxes-in-multiple-locations (May 1, 2025 five-region announcement incl. Mumbai)
- https://www.daytona.io/docs/en/sandboxes/ (lifecycle states, auto-stop/archive/delete, default/max resources)
- https://www.daytona.io/docs/en/billing/ (wallet, top-ups, 48h delay, metering units)
- https://www.daytona.io/docs/en/preview-and-authentication/ and https://www.daytona.io/docs/en/preview/ (preview URL formats, tokens, warning page)
- https://www.daytona.io/docs/en/custom-preview-proxy/ (WebSocket proxying quote, control headers)
- https://www.daytona.io/docs/en/architecture (components; proxy supports HTTP + WebSocket; namespace isolation)
- https://www.daytona.io/docs/en/security-exhibit/ (Sysbox runtime, encryption, SOC2 Type I/II status, pen tests, vuln SLAs)
- https://www.daytona.io/docs/en/bring-your-own-compute (BYOC mechanics, Helm/EKS, runner tokens)
- https://www.daytona.io/docs/en/snapshots/ (snapshot classes incl. Linux VM/Windows, hot vs cold, 2-week deactivation)
- https://www.daytona.io/docs/en/typescript-sdk/sandbox/ (`_experimental_fork`, `_experimental_createSnapshot`, pause)
- https://www.daytona.io/changelog/sandbox-fork-and-snapshot-endpoints (v0.165.0, 2026-04-14)
- https://www.daytona.io/changelog/sandbox-forking-sdk-and-org-metrics (v0.166.0, 2026-04-15)
- https://www.daytona.io/changelog/job-based-runners-custom-regions (v0.132.0, 2026-01-18)
- https://www.daytona.io/dotfiles/trust-center (trust center launch, 2025-10-13) and https://trust.daytona.io/
- https://www.daytona.io/dotfiles/daytona-raises-24m-series-a-to-give-every-agent-a-computer (Series A, 2026-02-05) and https://www.prnewswire.com/news-releases/daytona-raises-24m-series-a-to-give-every-agent-a-computer-302680740.html
- https://www.daytona.io/dotfiles/supercharging-ai-startups-with-up-to-50k-in-credits and https://www.daytona.io/startups (Startup Grid)
- https://www.vestbee.com/insights/articles/daytona-secures-a-5-m-seed-round and https://www.finsmes.com/2024/06/daytona-raises-5m-in-seed-funding.html (seed round)
- https://tracxn.com/d/companies/daytona/__TzaXWUoUzJqHEQmWu6SWgVcuHYFltYtBs_uhDgw84Ss (total funding ~$31M)
- https://www.linkedin.com/posts/stephanie-palazzolo_datadog-and-figma-back-a-startup-developing-activity-7425203231607341056-NzMb ($125M valuation report)
- https://status.app.daytona.io/ (uptime + 2026 incidents, checked 2026-07-02)
- https://vercel.com/blog/vercel-sandbox-is-now-generally-available (Vercel Sandbox GA, 2026-01-30) and https://vercel.com/docs/sandbox/concepts/snapshots
- https://northflank.com/blog/best-byoc-sandbox-platforms and https://northflank.com/blog/self-hostable-alternatives-to-daytona (BYOC status analysis)
- https://blaxel.ai/blog/daytona-dev-environment-pricing-alternatives (per-second rate equivalents)
- https://pixeljets.com/blog/ai-sandboxes-daytona-vs-microsandbox/ and https://www.softwareseni.com/e2b-daytona-modal-and-sprites-dev-choosing-the-right-ai-agent-sandbox-platform/ (isolation-options analyses)
- https://www.freestyle.sh/blog/product/what-is-a-daytona-snapshot-and-how-it-compares (live-snapshot experimental status, 2026-05-20)
- https://x.com/benswerd/status/2069907636921966676 and https://x.com/peer_rich/status/2070273692865552621 (community reaction)
