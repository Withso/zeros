# Enterprise self-hosting / BYOC patterns for dev tools — research notes

Researched: 2026-07-02. Scope: how dev-tool companies serve enterprises that demand "our data stays on our servers" — deployment models, control-plane/data-plane splits, packaging requirements, enterprise table stakes, pricing norms, and the sane phased path for a small startup like Zeros.

Confidence marks: **[verified]** = confirmed on official/primary source (usually fetched directly), **[likely]** = credible secondary source or single source, **[unverified]** = plausible but not confirmed.

---

## 1. The deployment spectrum — the five models everyone converges on

Every dev-tool vendor ends up on the same spectrum (EnterpriseReady.io — the canonical guide, written by the Replicated team + Segment et al.) **[verified]**:

1. **Multi-tenant SaaS** — vendor cloud, shared infra. Cheapest, default.
2. **Single-tenant SaaS** — private instance, still hosted and managed BY THE VENDOR (e.g., GitLab Dedicated, Sourcegraph Cloud). Customer gets isolation + data residency without operating anything.
3. **BYOC (bring-your-own-cloud)** — vendor's software runs in the CUSTOMER's AWS/GCP account/VPC; vendor keeps a hosted control plane and operates the software remotely. Customer owns the data boundary; vendor owns the operational burden.
4. **Full self-host / customer-managed ("on-prem")** — customer runs everything, including the control plane, from vendor-supplied packages (Helm chart, Docker Compose, binary) + a license key.
5. **Air-gapped** — self-host with NO internet: offline install bundles, offline license files, manual update transfer.

Key definitional nuance (Northflank, 2025-2026) — the "real vs fake BYOC" test: *"Can the vendor see the payload of a request to your application?"* In genuine BYOC the answer is no; if the vendor's load balancer terminates traffic before forwarding to your VPC, it's actually single-tenant SaaS, not BYOC. **[verified — northflank.com/blog/what-is-byoc-in-cloud-computing]**

The three-layer BYOC anatomy (consistent across Northflank, Railway, Nuon, Redpanda posts) **[verified]**:
- **Control plane** (vendor cloud): UI, API, scheduler, deploy pipeline, observability backend. Holds *metadata* (service names, env vars, deploy history, health metrics) — not customer data.
- **Data plane** (customer cloud): VPC, subnets, IAM roles, K8s nodes/VMs where workloads run and databases/secrets live.
- **Data path**: user traffic enters the customer VPC directly; the vendor control plane is never in the request path.

Connectivity patterns for the control plane ↔ data plane link:
- **Agent-based / outbound-only ("zero-trust BYOC")**: an agent in the customer account polls the vendor control plane; vendor holds no persistent inbound access or stored credentials; short-lived scoped tokens. This is the pattern auditors like. **[verified — Nuon blog; corroborated by Redpanda "data plane atomicity" post]**
- **Scoped cross-account IAM role**: vendor assumes a role in the customer account restricted by tags/policies (Depot's model, below). **[verified]**
- **Data plane atomicity** (Redpanda's term): the data-plane app should have no external runtime dependencies — control-plane downtime must not take down customer workloads. **[likely — Redpanda blog via search summary]**

Why BYOC demand exploded in 2024-2026 (Northflank/Railway, 2026): regulated industries (HIPAA/FedRAMP/PCI/ITAR), data residency (GDPR fines "exceeded €3 billion in the first half of 2025"), burning committed cloud spend (AWS EDP credits), and — fastest-growing — **GPU/AI workloads on reserved capacity that physically can't move**, so the platform must come to the compute. **[verified — both posts]**

Railway's counter-position (blog, 2026): Railway explicitly is NOT a BYOC platform — "a managed PaaS on infrastructure we own." Their rule of thumb: *"pursue BYOC solutions only if you can articulate the specific benefit in one sentence"*; SOC 2-only compliance needs, small cloud commitments, or stateless services do NOT justify BYOC's operational complexity. **[verified — blog.railway.com/p/what-is-byoc-developer-guide-2026]** (Relevant to Zeros since the founder is considering Railway: Railway itself won't be a BYOC answer for Zeros' enterprise story.)

---

## 2. Company-by-company: how each vendor actually does it

### Coder (cloud dev environments — closest analog to Zeros' category)
- Model: **full self-host, open core**. The customer installs and runs the "Coder server" control plane themselves (their infra: cloud or on-prem); it provisions workspaces via **Terraform templates**, connects them over **WireGuard tunnels**, auto-stops idle workspaces. **[verified — coder.com/docs/about + GitHub]**
- Free/OSS tier: unlimited workspaces/templates, unlimited members in a single organization, **OIDC SSO included in free tier** (notable — no SSO tax on basic OIDC), web UI/CLI/API, AI-agent task assignment. **[verified — coder.com/pricing]**
- **Premium (paid, annual per-user, price not public / contact sales)** adds: audit logging, group & user RBAC + custom roles, multi-organization access controls, high availability (multiple server replicas), workspace proxies (global low latency), resource quotas, unlimited git/auth integrations, branding, ticket-based global support with SLA. AI Governance / Agent Firewall / AI Gateway are separate paid add-ons (2025-2026). **[verified — coder.com/pricing]**
- Telemetry: collected by default from all installations; disable with `CODER_TELEMETRY_ENABLE=false`. **[verified — coder.com/docs/admin/setup/telemetry]**
- Positioning lesson: Coder's whole 2025 pitch is "run AI coding agents on YOUR infrastructure" — self-hosting *is* the product for security-sensitive orgs running agents. **[verified — coder.com/solutions/agents]**

### Sourcegraph (code search / AI)
- **The classic pivot story**: launched as cloud SaaS; through 2017 enterprises loved the demo but refused to "push their private code base to an external software provider." Mid-2017 they decided to pivot; **Dec 2017 released Sourcegraph 2.3 as on-prem self-hosted**; weekly active paid usage jumped; landed Lyft, Uber, Plaid, Convoy. Article epigraph: *"Trust is great. Control is better."* **[verified — sourcegraph blog "from SaaS to on-premises"]**
- Mechanics of the pivot: Docker packaging, Kubernetes orchestration, monthly release cadence, heavy release testing + admin docs. **[verified — same post]**
- Today: enterprise self-hosted supports Docker Compose (small/medium), Helm/Kubernetes (large, HA), single-node, machine images (being sunset in 7.0); supports external Postgres/Redis/object storage. In 2022 they added **Sourcegraph Cloud, a single-tenant vendor-hosted option for 100+ dev orgs** — i.e., they now run the full spectrum. **[verified — sourcegraph.com/docs/self-hosted + Wikipedia]**
- 2025: discontinued Cody Free/Pro/Enterprise Starter (effective 2025-07-23), pivoted AI effort to Amp. **[likely — search results, multiple sources]**

### GitLab (the pricing benchmark)
- Same tiers across SaaS and self-managed: **Premium $29/user/mo billed annually** (raised from $19 in 2023); **Ultimate custom** (historically ~$99 list; commonly negotiated to $60-99). Self-managed is the same license price — you save nothing on license, you just control the data; budget ~$1-5/user/mo extra for hosting. **[verified price — about.gitlab.com/pricing; negotiation ranges likely — vendr/spendbase]**
- **GitLab Dedicated** = single-tenant SaaS: fully isolated instance in your chosen AWS region, hosted/patched by GitLab, private networking + data residency, SOC 2 / ISO 27001 / **FedRAMP Moderate**. Reported floor ≈ **$26,000/month (~$312k/yr)**, typically **20-35% premium over GitLab.com pricing**. **[product verified — about.gitlab.com/dedicated; price figures likely — vendorbenchmark/vendr]**
- Telemetry policy example: Service Ping enabled by default on self-managed, disable-able in admin UI or gitlab.rb; GitLab deliberately does NOT ship third-party JS trackers (Pendo/Snowplow snippets) in self-hosted builds. **[verified — GitLab docs/issues]**

### GitHub Enterprise
- **$21/user/mo** buys GitHub Enterprise as a unified license: deploy **Enterprise Cloud (SaaS) or Enterprise Server (self-hosted) or both**, with unique-user licensing counted across deployments. Server infra costs are on the customer. Copilot / Advanced Security are separate add-ons. **[verified — docs.github.com + multiple pricing guides]** — This "one seat price, either deployment" is the cleanest pricing norm to copy.

### Retool (the on-prem-first scaling playbook — best single founder read)
- Went on-prem early for three reasons: (1) customers couldn't/wouldn't let cloud Retool reach their internal databases — on-prem guaranteed "no data ever left their VPC"; (2) security reviews shrank **from ~30 days to ~5 days** when self-hosted; (3) business-continuity comfort (app keeps running whatever happens to the vendor). **[verified — retool.com/blog/building-a-modern-on-prem-software-business]**
- Mechanics: shipped a **Docker image + docker-compose.yml with preconfigured Postgres**; first customer deploy was live "three days later… on an EC2 instance." Simplified the stack to make it shippable (replaced nginx with a Node process, replaced PM2 with custom clustering). Built a **"simple licensing endpoint to let on-prem instances check in"** plus an internal app to manage license keys. **[verified — same]**
- The killer architectural decision: **100% code reuse — "we can use the special on-prem images that we build to actually run our cloud multi-tenant solution."** One artifact, two businesses. **[verified — same]**
- Costs they admit: version fragmentation ("many versions of Retool in use at any given time"), can't force upgrades → higher support cost; debugging in someone else's infra → invested in JSON logs, CPU/memory telemetry, perf metrics. Scaled "a few million in ARR with 4 people" → "mid-8 figures ARR." **[verified — same]**
- Current pricing (2026): Free $0; Team $10/builder + $5/end-user; Business $50/builder + $15/end-user; Enterprise custom = SAML/OIDC SSO, audit logging, source control, custom branding, self-hosted supported (self-hosted setup "about 15 minutes via Docker"; license key from the Self-hosted Portal goes in .env/.yaml). **[verified — retool.com/pricing + docs]**

### Airbyte (open-core data movement)
- **Self-Managed Enterprise**: runs entirely on customer infra ("data never leaves your environment"), deployed on **Kubernetes via Helm** (Helm chart V2 mandatory from v2.1, 2025-2026); requires a **license key from sales**. Adds over OSS: SSO (Okta/Entra/OIDC), multi-workspace RBAC, user management, column hashing for PII, priority support with SLAs. **[verified — docs.airbyte.com/platform/enterprise-setup]**
- Pricing: moved to **capacity-based pricing** ("Data Workers" = pipeline horsepower) rather than per-seat or rows; median mid-market contract reported ≈ **$16,350/yr**, enterprise deals to **$100k+/yr**. **[pricing model verified — airbyte.com/blog/introducing-capacity-based-pricing; contract figures likely — vendr]**
- Note their 2025-2026 posture: docs actively nudge customers back to Cloud ("switch to Cloud… Private Link available if you require it") — self-managed is kept but clearly costs them. **[verified — docs]**

### Temporal (control-plane/data-plane by design)
- **Temporal Cloud**: Temporal runs the service (control plane + persistence); **customers run only Workers** — workflow/activity code executes on customer infra, so application code and most data can stay in the customer's environment even on the SaaS plan. Cell-based architecture: each cell = its own AWS account/VPC/EKS; 14 AWS regions + GCP support. **[verified — docs.temporal.io + Temporal blog]**
- The enterprise-features asymmetry is instructive: **Cloud has RBAC, SSO, audit logging, SOC 2 Type II, HIPAA; self-hosted Temporal does NOT ship RBAC or audit logging out of the box** — they deliberately kept enterprise governance in the paid cloud, while self-host (MIT OSS) gets raw capability but you build governance yourself. **[verified — docs + xgrid analysis]**
- Migration tooling works in any direction (self-hosted↔Cloud↔regions) — a durability/portability selling point. **[likely — Temporal docs via search]**

### Depot (fast CI builders — small-team BYOC done cheaply)
- **Depot Managed / self-hosted builders**: builds run in the customer's own AWS account — actually in a **single-tenant isolated sub-account within the customer's AWS Organization**. Depot keeps the control plane + web app; the **CLI talks directly to builder VMs via mTLS, so "build data and context never passes through Depot infrastructure."** **[verified — depot.dev/docs/self-hosted/architecture + blog]**
- Mechanics: an open-source **`cloud-agent` runs as a Fargate task** in the customer account with a **restricted IAM role that can only touch EC2 instances/EBS volumes tagged `depot-connection`** (Terraform-provisioned). Optional AWS PrivateLink / VPC peering keeps control↔data traffic off the public internet. Gated to the **Business plan**. **[verified — depot.dev blog/changelog/docs]**
- Why it matters for Zeros: this is the minimal-viable BYOC pattern for a small startup — open-source agent + tag-scoped IAM + direct mTLS from client to customer-side compute — no Kubernetes required.

### Northflank (BYOC as the product)
- Self-serve BYOC into **AWS, GCP, Azure, Oracle, CoreWeave, Civo, on-prem, bare-metal**: Northflank provisions and manages a K8s cluster in your account; control plane stays in Northflank's cloud; **"no added cost for running in your VPC," no per-seat pricing, no markup on compute** — same consumption rates as their managed cloud; enterprise tier (custom) adds SSO/SAML/OIDC, fine-grained RBAC, audit logging, HA/DR, 24/7 SLA. Full feature parity between managed and BYOC. **[verified — northflank.com/pricing + features pages]**

### E2B (AI sandboxes — direct comp to Zeros' sandbox layer)
- **BYOC, enterprise-only, not self-serve** (contact sales): AWS + GCP today, Azure in development. Deployed via **Terraform + machine images into a dedicated customer AWS account** with an IAM role provided to E2B; creates a new E2B "team" usable with the existing SDK/CLI.
- Data boundary: sandbox templates, snapshots, runtime logs, build sources, and **all sandbox traffic stay in the customer VPC**; only **"anonymized system metrics such as cluster memory and cpu"** go to E2B cloud for management. Load balancer can be fully internal (no public IP) with VPC peering. Self-hosting stack runs on **Nomad** (not K8s). Autoscaling still V1 (manual orchestrator scale-out). **[verified — e2b.dev/docs/byoc]**

### Daytona (the vendor in Zeros' current plan)
- OSS core is **AGPL-3.0**; managed cloud is usage-based ($200 signup credits). Enterprise: **customer-managed compute** — point Daytona at your own cloud account or on-prem hardware so "code or data never touches Daytona's servers"; **Helm charts** for K8s deployment (Docker/OCI containers by default, optional Kata Containers for VM-grade isolation), network egress controls, SOC 2 / HIPAA / GDPR coverage claimed. BYOC specifics are **not publicly documented / not self-serve — sales conversation required**. **[likely — Northflank comparison + daytona.io/GitHub; enterprise mechanics unverified because Daytona publishes little]**
- Implication for Zeros: the Daytona bet does not foreclose an enterprise story (customer-managed compute exists), but it is a contact-sales black box — worth asking Daytona directly what enterprise/BYOC actually looks like before depending on it.

### Runloop (AI devboxes)
- Managed cloud or **VPC deployment inside the customer's AWS** (some sources say AWS/GCP/Azure) on the Enterprise tier (custom pricing) alongside priority support and custom storage; microVMs on a custom bare-metal hypervisor; SOC 2 Type II, HIPAA, GDPR, **BAA and DPA available**; sold via AWS Marketplace ("Cloud or VPC"). **[likely — runloop.ai + AWS Marketplace listing via search; not fetched directly]**

### Cursor (the important COUNTER-example for AI dev tools)
- Cursor — at reported 64%-of-Fortune-500 penetration — **does not offer self-host/on-prem/VPC at all**: "While we don't offer on-premises deployment today, our cloud architecture delivers enterprise-grade security controls." Instead they sell **Privacy Mode (forcibly enabled for all team members; clients re-check enforcement every 5 minutes) + zero-data-retention (ZDR) agreements with OpenAI, Anthropic, Google, xAI, Fireworks** — code processed in volatile memory and discarded — plus enterprise controls: SCIM, MDM policies, audit logs, CMEK, AI Code Tracking API. **[verified — cursor.com/docs enterprise pages + cursor.com/enterprise]**
- Lesson: for AI coding tools in 2025-2026, many enterprises accept **"strong tenancy + ZDR + audit"** instead of self-hosting. Self-host is one answer to "our data stays on our servers," not the only one. A Zeros BYOC story (sandboxes in the customer's cloud) may actually beat Cursor's posture for the most paranoid buyers.

---

## 3. What each deployment model requires from the vendor

### BYOC requires
- A hosted **control plane** that holds only metadata; a clean API boundary between control plane and data plane (this is the "seam" — see §6).
- **Provisioning automation** into foreign accounts: Terraform modules / CloudFormation stacks / machine images (E2B: Terraform + AMIs; Nuon: CloudFormation + EKS + Karpenter; Depot: Terraform + Fargate agent). **[verified]**
- **Scoped access**: either an outbound-only polling agent (no vendor inbound access) or a tag/tag-condition-restricted cross-account IAM role (Depot). Optional break-glass debug role that the customer can toggle (Nuon pattern). **[verified]**
- **Private networking options**: internal load balancers, VPC peering, AWS PrivateLink (Depot, E2B, Airbyte Cloud all cite PrivateLink/peering). **[verified]**
- A telemetry contract: state exactly what leaves the customer account (E2B: "anonymized system metrics" only). **[verified]**
- Ops burden: the vendor is on-call for software running in accounts they don't fully control — quota limits, regional quirks, customer-side misconfig. This is why almost everyone gates BYOC to enterprise tier / contact-sales (E2B, Daytona, Depot-Business, Runloop). **[verified pattern]**

### Full self-host requires
- **Packaging** (EnterpriseReady taxonomy): Helm chart/K8s manifests for complex apps; Docker image / docker-compose for simpler ones; VM appliance (.ova/AMI); or single binary (Go/Java) for the simplest. Start with the simplest that works — Retool started with one Docker image + compose file. **[verified]**
- **License keys**: "each private instance requires a unique license that includes metadata about the instance including license expiration, as well as any features enabled/disabled" (EnterpriseReady). Retool: check-in licensing endpoint. Airbyte/Retool: key pasted into env/yaml. **[verified]**
- **Enterprise release channel + upgrade discipline**: separate cadence from SaaS, documented upgrade AND downgrade paths; Sourcegraph standardized on monthly releases; Retool accepted permanent version fragmentation as a cost. **[verified]**
- **Supportability tooling**: JSON logs, support bundles/diagnostics, resource telemetry (Retool built these specifically for on-prem debugging; EnterpriseReady lists "support diagnostics… automated support file generation"). **[verified]**
- **External-dependency flexibility**: support customer-provided Postgres/Redis/object storage (Sourcegraph, EnterpriseReady both). **[verified]**
- **Telemetry that is honest and switchable**: on by default is accepted (GitLab Service Ping, Coder) but must be disable-able and documented; never ship third-party trackers in self-host builds (GitLab's explicit stance). **[verified]**

### Air-gapped adds (mostly via Replicated's stack, the de-facto vendor here)
- **Air-gap bundles**: all images + charts packaged as a single downloadable .tgz; a **local Docker/OCI registry deployed inside the cluster** to serve images; install = `sudo ./app install --license license.yaml --airgap-bundle app.airgap`. **[verified — docs.replicated.com]**
- **Offline license files** (vCluster and others), offline update flow = watch "a local file path for the presence of manually transferred update packages" (EnterpriseReady). **[verified]**
- Support without internet: "every exchange — logs, screenshots, config files — can take hours or days," so engineering must sit inside the support loop from day one (Replicated). **[verified — replicated.com blog]**
- Air-gap is where defense/gov/FSI buyers live (Sourcegraph does air-gapped AI code assistant deals). Do not attempt this as a seed-stage startup.

---

## 4. Enterprise table stakes (the checklist buyers grade you on)

From the WorkOS enterprise-readiness checklist (2026 edition) + EnterpriseReady, in rough priority order **[verified — workos.com/blog/enterprise-readiness-checklist-2026]**:

1. **SSO (SAML 2.0 + OIDC)** — per-organization config, SP- and IdP-initiated, JIT provisioning, attribute mapping, cert rotation without downtime, test mode. Quote: "When a company wants to govern which employees can use which AI tools, SSO is the chokepoint that makes governance possible."
2. **Org-first multi-tenant data model** — "If organizations aren't a first-class concept in your data model from day one, retrofitting them later is a months-long migration that touches every table." (Most important early-design point in the entire checklist.)
3. **SCIM / directory sync** — auto provision + REAL-TIME deprovision (offboarding is the buyer's actual fear), group sync, Okta/Entra/Google/Workday schema quirks.
4. **RBAC** (predefined + customer-defined roles, org-scoped) and, later, fine-grained/ReBAC authorization. For agents: "the only safe default is that it inherits exactly that user's permissions, no more."
5. **Audit logs** — standard schema (actor, session, IP, geo), append-only 1+ year retention, customer-facing UI, streaming to SIEM (Splunk/Datadog/Panther/Elastic). "Enterprise procurement teams will ask for your audit log before they ask about your pricing." Increasingly must capture **agent actions, not just human actions** — directly relevant to Zeros.
6. **MFA** enforcement policies; **self-serve admin portal** (domain verification via DNS TXT, connection health monitoring — an expired SAML cert "at 2 a.m." is a real outage).
7. **Compliance paper**: SOC 2 Type II is the entry ticket (PostHog did it by April 2023 at small scale — a quarter-scale project, not years); ISO 27001 next; HIPAA/BAA and **DPAs** on request; FedRAMP only for the very committed (GitLab Dedicated has FedRAMP Moderate).
8. **Private networking**: PrivateLink/VPC peering options even for SaaS (Airbyte Cloud sells Private Link explicitly as the anti-self-host concession).
9. Newer (2026): **MCP/agent auth** — OAuth 2.1 + PKCE, tool-level token scoping, per-call audit — WorkOS now lists this as its #2 checklist item; for an agent-orchestration product like Zeros this is likely to appear in security questionnaires within a year.

**Buy-vs-build for this layer**: WorkOS pricing (2026) — SSO and SCIM each **$125/connection/mo for the first 1-15 connections**, sliding to $50 at 101-200; audit-log streaming $125/mo per SIEM connection + $99/mo per 1M events retained; AuthKit free to 1,000,000 MAUs. So "enterprise-ready auth" for the first ~10 enterprise customers ≈ $1-3k/mo — cheap vs. eng time. Competitors: Clerk, Scalekit, SuperTokens, Frontegg. **[verified — workos.com/pricing]**

**The SSO tax** (context for pricing decisions): sso.tax ("SSO Wall of Shame") documents vendors gating SAML behind enterprise tiers at markups of 50% (Notion) to 425% (GitHub $4→$21), 275% (Figma $12→$45), up to ~4,900% (Cloudflare). CISA's Secure-by-Design guidance says SSO should "be available by default as part of the base offering." Marginal infra cost of SAML ≈ $0.015/user/mo. Norm in dev tools: gate *SAML+SCIM+audit* behind the business/enterprise tier but keep OIDC SSO broadly available (Coder gives OIDC SSO free). **[verified — sso.tax + secondary analyses]**

---

## 5. Licensing + pricing norms (what people actually charge)

Observed patterns, with examples:

| Pattern | Examples | Notes |
|---|---|---|
| **Same per-seat price, either deployment** | GitHub Enterprise $21/user/mo covers Cloud AND Server (unique users counted across both) **[verified]**; GitLab Premium $29/user/mo same for SaaS & self-managed **[verified]** | Cleanest model; self-host is a deployment option, not a separate SKU |
| **Self-host gated to top tier, custom-priced** | Retool Enterprise (custom; below that: Team $10+$5, Business $50+$15) **[verified]**; Coder Premium (custom) **[verified]**; Airbyte SME (license key via sales) **[verified]** | The dominant dev-tool pattern: self-host = enterprise tier = contact sales |
| **Single-tenant SaaS at a premium** | GitLab Dedicated ≈ $26k/mo floor, 20-35% over SaaS **[likely]** | Vendor keeps ops; customer pays for isolation |
| **BYOC with no infra markup, fee on platform** | Northflank: no VPC surcharge, no seats, pay same consumption rates **[verified]**; Depot: BYOC gated to Business plan **[verified]** | Customer's cloud bill absorbs compute; vendor monetizes the control plane |
| **Capacity/usage-based enterprise** | Airbyte "Data Workers" capacity pricing; median mid-market ≈ $16.4k/yr, enterprise to $100k+ **[model verified, figures likely]** | Fits infra-shaped products better than seats |
| **Open core + paid governance** | Coder (OSS free; audit/RBAC/HA/multi-org paid) **[verified]**; Temporal (OSS self-host lacks RBAC/audit; Cloud has them) **[verified]** | Governance/compliance features are the paywall, not core function |
| **Support tiers as the product** | Airbyte SME "priority assistance with SLAs"; Coder "ticket-based global support with SLA"; Northflank "24/7 support & SLA" **[verified]** | Enterprises pay for a throat to choke as much as for features |

Anchor numbers worth quoting: enterprise self-host/BYOC deals in dev infra typically start **$20k-$100k+/yr**; single-tenant hosted starts far higher (GitLab Dedicated ~$312k/yr); WorkOS makes the auth checklist ~$1-3k/mo at first-10-customers scale.

---

## 6. The phased path for a small startup (design early vs defer)

### Cautionary tales (why NOT to build this too early)
- **PostHog killed its Kubernetes self-hosted offering (May 31, 2023)**: only **3.5% of users** ran it, yet it consumed a disproportionate share of a small infra team — failures "crop up in every part of the stack. In event ingestion, Kafka, ClickHouse, Postgres, Redis and within the application itself"; they had to "vet [customers'] engineering team for Kubernetes experience" before onboarding; even a full disk could down an instance "for hours or days." They kept only the Docker Compose "hobby" deploy (MIT, no guarantees) and paid-cloud. **[verified — posthog.com/blog/sunsetting-helm-support-posthog]**
- **Replicated's "biggest mistakes" list** **[verified — replicated.com blog]**:
  1. Over-engineering: shipping GitOps/service mesh/monitoring stacks to customers — "every extra layer adds friction for your customers and becomes a hidden cost for your team."
  2. Lifting SaaS architecture unchanged (forcing customers to run Argo CD, Istio, Vault).
  3. Assuming infra experts deploy it — the real installer is a domain practitioner.
  4. **Cloud lock-in**: early dependence on Lambda/BigQuery/Cosmos-style proprietary primitives later blocks "regulated industries, government agencies, Fortune 500, multi-cloud" — the one mistake you must avoid EARLY because it's near-impossible to unwind.
  5. Separating support from engineering (fatal in air-gap; painful everywhere).
- Sourcegraph shows the flip side: refusing to self-host when your buyer's asset is *their private code* can stall the whole company (their 2017 conversion wall). AI-agent workspaces holding customer code sit in exactly that category.

### Phase 0 — now (design the seams, build nothing extra)
Cheap decisions that keep every future door open:
1. **Organizations as a first-class data-model concept from day one** (WorkOS: retrofitting = "months-long migration that touches every table"). Per-org config for auth, workspaces, billing.
2. **Avoid proprietary cloud primitives in the data plane.** Postgres/SQLite + object-storage-compatible APIs + plain containers/VMs — all portable. (Zeros' current plan already scores well: engine + zeros.db SQLite live inside the sandbox; durability = git remote + export blobs. The sandbox is effectively already a self-contained data-plane unit.)
3. **Keep the control-plane/data-plane boundary explicit**: control plane (auth, workspace registry, provisioning worker holding the Daytona key) should hold metadata only; chat/code/artifacts stay in the sandbox. If that boundary stays clean, "BYOC" later ≈ "run the same sandbox image in the customer's account and point the registry at it."
4. **One artifact for all deployments** (Retool's 100%-code-reuse rule): the engine image that runs in Daytona should be the same image a customer could someday run in their own VPC.
5. **Direct client↔data-plane connections with the vendor out of the data path** (Zeros' preview-URL WSS + per-user token already matches the Depot/E2B "real BYOC" data-path property — preserve it).
6. A **telemetry switch** and a written one-line data-flow statement (what leaves the workspace, to whom). Costs nothing now; is the first security-questionnaire answer later.

### Phase 1 — first enterprise interest (~first 5-20 team customers)
- Buy the auth layer: SAML SSO + SCIM + audit-log events via WorkOS or similar (~$125/connection/mo).
- SOC 2 Type II (a quarter-scale project with Vanta/Drata-style tooling; PostHog did it small).
- DPA template, security page, subprocessor list; ZDR posture for model providers (the Cursor playbook) — for many buyers this substitutes for self-hosting entirely.
- Gate SAML/SCIM/audit to a Business/Enterprise tier (standard practice), but consider keeping basic OIDC SSO cheap (Coder precedent, CISA guidance, sso.tax backlash).

### Phase 2 — real "our servers" demand with money attached
- Ship **BYOC before self-host**: keep your control plane, run sandboxes in the customer's AWS/GCP account. Depot's minimal pattern (open-source outbound agent or tag-scoped IAM role + Terraform + direct mTLS/WSS from client to customer-side compute) is the proven small-team version. Gate it to enterprise tier, priced $30-100k+/yr.
- Or buy the machinery: **Replicated** (self-host/air-gap distribution: licensing, air-gap bundles, support bundles), **Nuon** (BYOC control-plane-as-a-service), **Distr** (open-source distribution platform) exist precisely so startups don't build this. **[verified these vendors exist and do this]**
- Only descend to full self-host of the *control plane* when a specific contract pays for it — and package with Docker Compose/single image first, Helm only when a real customer's platform team demands it (Replicated + PostHog evidence).
- Air-gapped: defer indefinitely unless pursuing defense/gov.

### Common mistakes checklist (condensed)
- Building on-prem before any customer pays for it (PostHog's 3.5%).
- Shipping your SaaS topology as the customer package (Replicated #1/#2).
- Cloud-primitive lock-in in the data plane (Replicated #4 — the only unforgivable early mistake).
- Doing BYOC without a one-sentence justification from the buyer (Railway test).
- Treating SSO/SCIM/audit as engineering projects instead of $125/mo purchases.
- Underestimating version fragmentation + can't-force-upgrades support cost (Retool's admitted downside).

---

## 7. Direct implications for Zeros (mapping, brief)

- Zeros' architecture (self-contained engine+DB per sandbox, git-remote durability, thin provisioning worker, direct WSS from Mac to sandbox) is **accidentally BYOC-shaped** — the sandbox is a data-plane atom, and the vendor is already out of the data path. The main discipline needed: keep the Supabase/Railway control plane metadata-only (no chat content, no code) so the enterprise story stays one sentence: "your agents, your code, your chat run in your cloud; we only orchestrate."
- Daytona's enterprise/BYOC posture is not publicly documented — ask Daytona sales what customer-managed compute concretely looks like before assuming it can carry Zeros' future enterprise deals; E2B BYOC (Terraform into customer AWS/GCP) is the documented fallback pattern.
- Competitive angle: Cursor cannot self-host; Conductor (per product context) runs on Vercel Sandbox/Fly. A Zeros "workspaces in YOUR cloud" enterprise tier would be a real differentiator among Mac-native agent managers — but per every source above, not before paying demand exists.

---

## Sources

- https://northflank.com/blog/what-is-byoc-in-cloud-computing — BYOC definition, 3-layer architecture, real-vs-fake test, use cases, GDPR fines figure (fetched)
- https://blog.railway.com/p/what-is-byoc-developer-guide-2026 — Railway's BYOC guide, "not a BYOC platform," one-sentence test (fetched)
- https://nuon.co/blog/byoc-control-plane-data-plane-architectures — agent-based BYOC mechanics, cross-account IAM debug roles, CloudFormation/EKS provisioning flow (fetched)
- https://www.redpanda.com/blog/byoc-data-plane-atomicity-secure-cloud — data-plane atomicity concept (search summary)
- https://coder.com/pricing — Coder Community vs Premium feature split (fetched)
- https://coder.com/docs/about + https://github.com/coder/coder — Coder server control plane, Terraform templates, WireGuard (search)
- https://coder.com/docs/admin/setup/telemetry — CODER_TELEMETRY_ENABLE (search)
- https://webflow.sourcegraph.com/blog/from-saas-to-on-premises — Sourcegraph 2017 SaaS→on-prem pivot (fetched)
- https://sourcegraph.com/docs/self-hosted — deployment methods, external services (fetched)
- https://about.gitlab.com/pricing/ — Premium $29, Ultimate custom, tier features (fetched)
- https://about.gitlab.com/dedicated/ + https://docs.gitlab.com/subscriptions/gitlab_dedicated/ — GitLab Dedicated single-tenant SaaS (search)
- https://vendorbenchmark.com/vendors/gitlab-pricing + https://www.vendr.com/marketplace/gitlab — Dedicated ~$26k/mo, 20-35% premium (search, likely)
- https://docs.gitlab.com/development/internal_analytics/service_ping/ + related GitLab issues — Service Ping telemetry policy (search)
- https://docs.github.com/en/enterprise-server@3.15/get-started/learning-about-github/githubs-plans + https://axolo.co/blog/p/github-enterprise-cost — GHE $21/user/mo unified Cloud+Server licensing (search)
- https://retool.com/blog/building-a-modern-on-prem-software-business — Retool on-prem playbook (fetched; key source)
- https://retool.com/pricing — Retool tiers/prices (fetched)
- https://github.com/tryretool/retool-onpremise + https://docs.retool.com/self-hosted/tutorials/kubernetes — Retool deployment mechanics (search)
- https://docs.airbyte.com/platform/enterprise-setup — Airbyte Self-Managed Enterprise features + license key (fetched)
- https://airbyte.com/blog/introducing-capacity-based-pricing + https://www.vendr.com/marketplace/airbyte — capacity pricing, contract sizes (search)
- https://docs.temporal.io/evaluate/development-production-features/cloud-vs-self-hosted-features — Cloud vs self-host feature split (fetched)
- https://docs.temporal.io/cloud/overview + https://www.xgrid.co/resources/temporal-cloud-vs-self-hosted/ + https://temporal.io/blog/building-durable-cloud-control-systems-with-temporal — cell architecture, RBAC/audit asymmetry (search)
- https://depot.dev/docs/self-hosted/architecture — Depot Managed architecture (fetched)
- https://depot.dev/blog/self-hosted-depot + https://depot.dev/changelog/2022-06-14-self-hosted-builders — cloud-agent, tag-scoped IAM, mTLS (search)
- https://northflank.com/pricing — BYOC no-markup/no-seat pricing, enterprise features (fetched)
- https://northflank.com/features/bring-your-own-cloud — supported clouds, self-serve BYOC (search)
- https://e2b.dev/docs/byoc — E2B BYOC full mechanics (fetched)
- https://www.daytona.io/ + https://github.com/daytonaio/daytona + https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes + https://blaxel.ai/blog/daytona-dev-environment-pricing-alternatives — Daytona AGPL, customer-managed compute, Helm (search, likely)
- https://runloop.ai/ + https://aws.amazon.com/marketplace/pp/prodview-6v2m5a6coprts + https://blaxel.ai/blog/ai-sandbox-platforms-secure-code-execution — Runloop VPC deployment, compliance (search, likely)
- https://cursor.com/docs/enterprise/privacy-and-data-governance + https://cursor.com/data-use + https://cursor.com/enterprise — Cursor no-self-host, Privacy Mode, ZDR (search)
- https://workos.com/blog/enterprise-readiness-checklist-2026 — 10-item enterprise readiness checklist (fetched; key source)
- https://workos.com/pricing — WorkOS SSO/SCIM/audit pricing (fetched)
- https://sso.tax/ + https://clerk.com/articles/the-real-cost-of-enterprise-sso-per-connection-vs-per-mau-pricing + https://www.satola.tech/2025/the-sso-tax-is-a-security-ransom-and-its-time-to-call-it-out/ — SSO tax data (search)
- https://www.enterpriseready.io/features/deployment-options/ — deployment spectrum, packaging, licensing, private-instance features (fetched; canonical guide)
- https://www.replicated.com/blog/avoiding-the-biggest-mistakes-in-on-prem-software-delivery — top on-prem delivery mistakes (fetched)
- https://docs.replicated.com/enterprise/installing-embedded-air-gap + https://docs.replicated.com/vendor/helm-install-airgap — air-gap bundle mechanics (search)
- https://posthog.com/blog/sunsetting-helm-support-posthog — PostHog K8s sunset post-mortem (fetched; key cautionary tale)
