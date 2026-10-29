# Rule enforcement

This is an inventory of the current gates, including the gaps. A named test
holds only its covered cases; it does not prove that every new caller obeys the
rule. “Judgment only” means no general automated gate exists. Review still owns
intent, truthful evidence, authorization, and the adequacy of new tests.

Each source list item with prose, ownership-table row and standalone paragraph
has one row below. Section labels and generator markers are excluded. The row's
hidden fingerprint binds its complete source text, including nested rules as
separate rows. The inventory deliberately includes introductory guidance so new
prose cannot silently escape it.

Run `pnpm test:git scripts/__tests__/zstack-enforcement.test.ts` after editing
AGENTS.md, RULES.md or this map. Update the affected mapping when a source
fingerprint changes; do not refresh a fingerprint without checking its enforcer.
The test also verifies every enforcer file, package command and CI job below.

The merge wrapper requires Why, What changes, Tests, Rollout, Local workspace
impact and Cloud workspace impact headings on human/agent PRs. Code fences,
HTML comments, quotes and lists are not sections. Only GitHub-confirmed bot
authors retain their existing body policy; CI-definition and incident-marker
refusals still apply. Runtime automation creates PRs and never invokes this
wrapper; CI recovery creates owner-resolved incident PRs. A valid heading does
not prove its contents, and bypassing the wrapper remains a review concern.

## AGENTS.md

| Rule | Enforcers | Scope and remaining judgment |
| --- | --- | --- |
| [A1](../../AGENTS.md#zeros-repository-guide-for-coding-agents) Apply the repository instructions before changing code. <!-- rule:AGENTS.md:99a3da3cf75fe887 --> | judgment only | Review; no general automated gate. |
| [A2](../../AGENTS.md#working-method) Treat docs as guidance; code, tests, schemas and the guide are authoritative. <!-- rule:AGENTS.md:14e9291ab09bbd00 --> | judgment only | Review; no general automated gate. |
| [A3](../../AGENTS.md#working-method) Trace imports and non-import references before moves or renames. <!-- rule:AGENTS.md:4c250f3951001147 --> | `repository-layout.test.ts` | Known paths and barrels only; completeness of the trace is judgment. |
| [A4](../../AGENTS.md#working-method) Preserve behavior and serialized compatibility unless migration is requested. <!-- rule:AGENTS.md:f7751a7426ca1cdc --> | `check:protocol`, `check:migrations`, `check:packaging-paths` | These contracts are checked; feature equivalence and migration intent need review. |
| [A5](../../AGENTS.md#working-method) Keep changes scoped and preserve unrelated dirty-tree work. <!-- rule:AGENTS.md:3c84174f8be7b8e7 --> | judgment only | Review; no general automated gate. |
| [A6](../../AGENTS.md#working-method) Handle Local Personal, organization-local and cloud owners and placements. <!-- rule:AGENTS.md:b627ca8a4a974931 --> | `test:workspace-lifecycle`, `workspace-cache-transitions.test.ts` | Covered lifecycle/switching paths only; each changed feature needs placement review. |
| [A7](../../AGENTS.md#working-method) Add and retain a failing regression before fixing a bug. <!-- rule:AGENTS.md:5afedeb2a4aa4063 --> | judgment only | Test existence and red-before-fix chronology are reviewed, not inferred from CI green. |
| [A8](../../AGENTS.md#working-method) Run adjacent suites after each meaningful edit. <!-- rule:AGENTS.md:6f7fe96a843a8c3e --> | `zstack/verify.mjs` | The invoked selector requires adjacency; when it is run remains judgment. |
| [A9](../../AGENTS.md#working-method) Use zstack, record orchestration, learn, and regenerate provider copies. <!-- rule:AGENTS.md:d79abdf3f0196f98 --> | `zstack.test.ts`, `check:ui` | Pack shape and generated copies; actual task orchestration is judgment. |
| [A10](../../AGENTS.md#working-method) Use Design registration, preserve legacy manifests and frame identity, follow context. <!-- rule:AGENTS.md:09f1bc695879f696 --> | `design/manifest.test.ts`, `check:design-containment` | Manifest/native-tool contracts; instruction interpretation and stable-ID intent need review. |
| [A11](../../AGENTS.md#working-method) Frames contain supported HTML/CSS/assets; authored JavaScript does not execute. <!-- rule:AGENTS.md:0db90ae41737c812 --> | `design/source-sanitizer.test.ts`, `check:design-containment` | Sanitization and containment; app implementation follows its own runtime. |
| [A12](../../AGENTS.md#working-method) Save native Design source directly; validate and capture through the native path. <!-- rule:AGENTS.md:c6b510d69e3b829f --> | `design/agent-drafts.test.ts`, `check:design-containment` | Transactional source behavior; actual preview/capture evidence is operator judgment. |
| [A13](../../AGENTS.md#working-method) Use Design lifecycle operations and keep Git conflicts and permissions authoritative. <!-- rule:AGENTS.md:2d73c660c653180e --> | `design/manifest.test.ts`, `check:design-containment`, `project-capabilities.test.ts` | Known registration/containment/capability paths; lifecycle choice still needs review. |
| [A14](../../AGENTS.md#working-method) Commit complete Design source; keep private state private and legacy pointers readable. <!-- rule:AGENTS.md:de52c03cdcc93607 --> | `design/manifest.test.ts`, `check:secrets` | Legacy manifest reads and secret patterns; completeness of a Design commit is judgment. |
| [A15](../../AGENTS.md#working-method) Preserve the one-VM cloud boundary, signed worker access and pinned runtime. <!-- rule:AGENTS.md:fbbd969750ed9f8b --> | `worker/runtime-boundary.test.ts`, `worker/worker-auth.test.ts`, `cloud/runtime.test.ts` | Standalone imports, grants and runtime scripts; deployed VM/provider behavior needs live proof. |
| [A16](../../AGENTS.md#renderer-invariants) Deduplicate keyed reads and retain the last confirmed exact-key snapshot. <!-- rule:AGENTS.md:8fe1303ac1e917d9 --> | `keyed-async-cache.test.ts`, `workspace-cache-transitions.test.ts` | Shared cache and workspace transitions; new consumers need their own race coverage. |
| [A17](../../AGENTS.md#renderer-invariants) Derive each Git view/count from its comparison; All owns the badge and AD is 0/0/1/1. <!-- rule:AGENTS.md:b31c7da1478540c7 --> | `git/diff.test.ts` | Git comparison cases; UI badge plumbing also needs adjacent UI tests. |
| [A18](../../AGENTS.md#renderer-invariants) Target selection writes metadata; history mutations require a separate explicit action. <!-- rule:AGENTS.md:55e5498f222bd860 --> | judgment only | No general gate proves a selector cannot initiate a history mutation. |
| [A19](../../AGENTS.md#renderer-invariants) Publish destination identity atomically and restore/prune semantic-owner selections. <!-- rule:AGENTS.md:616ce42f1d0c842d --> | `navigation-memory.test.ts`, `workspace-cache-transitions.test.ts` | Navigation and cached workspace paths; other owners need equivalent tests. |
| [A20](../../AGENTS.md#renderer-invariants) Prune descendant cwd keys without crossing a registered nested owner. <!-- rule:AGENTS.md:cc6a57b44431e14f --> | `navigation-memory.test.ts` | Nested repository and deleted-workspace cases. |
| [A21](../../AGENTS.md#renderer-invariants) Warm on pointer/focus intent; urgent clicks do not await I/O. <!-- rule:AGENTS.md:71e7bac9b415d46b --> | judgment only | No general lint or test proves all click paths are free of waits. |
| [A22](../../AGENTS.md#renderer-invariants) Bound retained surfaces and keep hidden effects, focus, shortcuts and polling inert. <!-- rule:AGENTS.md:0e6aeff1e5787fef --> | `pane-portal-store.test.ts`, `local-hidden-chat-preparation.test.ts` | Portal retention and hidden chat preparation; each added effect needs review. |
| [A23](../../AGENTS.md#renderer-invariants) Reuse aggregates and stable selector/collection references; avoid waterfalls. <!-- rule:AGENTS.md:9e374fa6d2469506 --> | `read-caches.test.ts`, `keyed-async-cache.test.ts` | Shared reads only; hot consumers and per-row request cost need review. |
| [A24](../../AGENTS.md#renderer-invariants) Gate internal surfaces and hotkeys on staff authorization plus the feature flag. <!-- rule:AGENTS.md:ae49711cbb592f69 --> | `internal-features.test.ts`, `check:ui` | Gate semantics and scanned uses; dynamic surfaces still need review. |
| [A25](../../AGENTS.md#renderer-invariants) Read the relevant design, performance, tool-presentation and Local CLI guidance. <!-- rule:AGENTS.md:c6432ef7c3998fdf --> | `design-system-docs.test.ts` | Generated guidance is checked; actually reading and applying it is judgment. |
| [A26](../../AGENTS.md#agent-credentials) Use the private Alpha/test credential file and never add Beta or Production keys. <!-- rule:AGENTS.md:dd174812e48665a9 --> | `agent:check`, `check:secrets` | Environment contract and repository secret patterns; account/channel choice is operator judgment. |
| [A27](../../AGENTS.md#agent-credentials) Check credentials read-only and never expose their values. <!-- rule:AGENTS.md:d69b9b014b844ac8 --> | `agent:check`, `check:secrets`, `CI secret scan` | Repository/commit scanning cannot prove that arbitrary command output is secret-free. |
| [A28](../../AGENTS.md#agent-credentials) Use workspace Git/GitHub identity and the agent Co-Authored-By trailer. <!-- rule:AGENTS.md:3035352f84448c60 --> | `agent:merge` | Immediate merge pins workspace identity; prior commit authors and trailers need review. |
| [A29](../../AGENTS.md#agent-credentials) Use the merge wrapper, require owner merges for CI definitions, and document force overrides. <!-- rule:AGENTS.md:b3dec1088db3e327 --> | `agent:merge` | Wrapper refuses protected paths and guards identity/queue/overrides; bypassing it is judgment. |
| [A30](../../AGENTS.md#agent-credentials) Reserve the bot for release automation; keep its key outside the repository. <!-- rule:AGENTS.md:51158c096260e0bc --> | `check:secrets` | Key patterns only; deciding whether work is a person's work is judgment. |
| [A31](../../AGENTS.md#verification) Run the required baseline and adjacent suites before handoff. <!-- rule:AGENTS.md:8e6ac630b0acb3b3 --> | `zstack/verify.mjs`, `CI quality` | Selector and selected CI gates enforce their recipes; local execution timing is judgment. |
| [A32](../../AGENTS.md#verification) Check UI/style policy, regenerate changed tokens, and never raise UI debt. <!-- rule:AGENTS.md:acc3b58c9e1e9f9f --> | `check:ui`, `check:tokens` | Generated bytes and policy ratchet; intentional exceptions require review. |
| [A33](../../AGENTS.md#verification) Run exact-key/race tests and build performance-sensitive UI. <!-- rule:AGENTS.md:11ba3f27a3caca50 --> | `build:ui`, `keyed-async-cache.test.ts` | Build and shared cache; realistic performance and changed-path races need review. |
| [A34](../../AGENTS.md#verification) Run UI smoke for composer, overlay, focus and popover changes. <!-- rule:AGENTS.md:74eed9b05484fef2 --> | `test:ui-smoke` | Harness scenarios only; task-specific interaction coverage is judgment. |
| [A35](../../AGENTS.md#verification) Run preload validation and Electron tests after IPC/preload changes. <!-- rule:AGENTS.md:6886207571edb14a --> | `check:preload` | The allowlist gate is automated; selecting relevant native tests is judgment. |
| [A36](../../AGENTS.md#verification) Run engine lifecycle smoke on macOS. <!-- rule:AGENTS.md:ccb6e0a3cd2e89b2 --> | `smoke:engine` | Requires macOS; a Linux run supplies no native lifecycle proof. |
| [A37](../../AGENTS.md#verification) Test and typecheck the control plane independently. <!-- rule:AGENTS.md:54ac503c72e0a88b --> | `test:control-plane`, `control-plane:typecheck` | Database-backed suites also need their PostgreSQL fixture. |
| [A38](../../AGENTS.md#verification) Validate changed workflow definitions. <!-- rule:AGENTS.md:11d7cd3321251ebe --> | `check:actions` | Actionlint and concurrency validation; CI definitions still require owner merge. |
| [A39](../../AGENTS.md#verification) Run matching migration, packaging, protocol, deep-link and deployment gates. <!-- rule:AGENTS.md:d8bc7d925b6197cf --> | `check:migrations`, `check:control-plane-migrations`, `check:packaging-paths`, `check:protocol`, `check:deep-link-schemes`, `check:web-deploy` | Each validates its named contract; deployment behavior needs applicable live checks. |
| [A40](../../AGENTS.md#verification) Check licenses after dependency, generated-code or packaged-asset changes. <!-- rule:AGENTS.md:a9992dce89d52c3b --> | `check:licenses` | Audited graphs/notices only; provenance still needs human review. |
| [A41](../../AGENTS.md#verification) Report a platform-only check as unverified unless run on that platform. <!-- rule:AGENTS.md:794d8ab1db8caba6 --> | judgment only | Receipts show the host; interpreting or overstating evidence remains judgment. |
| [A42](../../AGENTS.md#ci-selection) Preview path-selected CI lanes; labels add checks and CI definitions need owner merge. <!-- rule:AGENTS.md:da59d267f3309a1a --> | `ci:plan`, `CI scope`, `agent:merge` | Path floors, label vocabulary and wrapper refusal; owner review itself is human. |

## RULES.md

| Rule | Enforcers | Scope and remaining judgment |
| --- | --- | --- |
| [R1](../../RULES.md#zeros-development-rules) Apply the repository instructions before changing code. <!-- rule:RULES.md:9ffc0f9228950d32 --> | judgment only | Review; no general automated gate. |
| [R2](../../RULES.md#1-preserve-behavior-and-compatibility) Preserve behavior and serialized compatibility unless migration is requested. <!-- rule:RULES.md:b61e504c9028e9e1 --> | `check:protocol`, `check:migrations`, `check:packaging-paths` | These contracts are checked; feature equivalence and migration intent need review. |
| [R3](../../RULES.md#1-preserve-behavior-and-compatibility) Trace imports and non-import references before moves or renames. <!-- rule:RULES.md:16909d2c80db9e87 --> | `repository-layout.test.ts` | Known paths and barrels only; completeness of the trace is judgment. |
| [R4](../../RULES.md#1-preserve-behavior-and-compatibility) Preserve persisted/wire/environment/DOM identifiers or migrate with compatibility tests. <!-- rule:RULES.md:08adf2e1add9de1e --> | `check:protocol`, `check:deep-link-schemes`, `check:migrations` | Specific serialized contracts; arbitrary identifier changes require review. |
| [R5](../../RULES.md#1-preserve-behavior-and-compatibility) Target selection writes metadata; history mutations require a separate explicit action. <!-- rule:RULES.md:8925a107258591dd --> | judgment only | No general gate proves a selector cannot initiate a history mutation. |
| [R6](../../RULES.md#1-preserve-behavior-and-compatibility) Derive each Git view/count from its comparison; All owns the badge and AD is 0/0/1/1. <!-- rule:RULES.md:8de56d451d22b90c --> | `git/diff.test.ts` | Git comparison cases; UI badge plumbing also needs adjacent UI tests. |
| [R7](../../RULES.md#1-preserve-behavior-and-compatibility) Keep changes scoped and preserve unrelated dirty-tree work. <!-- rule:RULES.md:60aea82be91c14f0 --> | judgment only | Review; no general automated gate. |
| [R8](../../RULES.md#2-repository-boundaries) Keep the intentional top-level repository layout. <!-- rule:RULES.md:31421a910ea7b6f4 --> | `repository-layout.test.ts` | Audited directories and known boundaries only. |
| [R9](../../RULES.md#2-repository-boundaries) Desktop owns Electron, Local engine and renderer. <!-- rule:RULES.md:7365215863b2da59 --> | `repository-layout.test.ts` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R10](../../RULES.md#2-repository-boundaries) Control plane owns the API, feedback and migrations. <!-- rule:RULES.md:220727fe056c00b7 --> | `repository-layout.test.ts` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R11](../../RULES.md#2-repository-boundaries) Cloud worker owns standalone VM agents, chat, files, Git and terminals. <!-- rule:RULES.md:cb1eccf29a55815b --> | `worker/runtime-boundary.test.ts` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R12](../../RULES.md#2-repository-boundaries) Web owns the hub, auth handoff and edge functions. <!-- rule:RULES.md:6c7bc7c8b2163c17 --> | `check:web-deploy` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R13](../../RULES.md#2-repository-boundaries) Marketing source is assembled into web deployment. <!-- rule:RULES.md:e2c19b6b732cd4b3 --> | `check:web-deploy` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R14](../../RULES.md#2-repository-boundaries) Protocol owns shared transport schemas and redaction. <!-- rule:RULES.md:f1817eea66a7fdf8 --> | `check:protocol` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R15](../../RULES.md#2-repository-boundaries) The logo-particles package owns the shared canvas field. <!-- rule:RULES.md:1013abdd95149533 --> | `repository-layout.test.ts` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R16](../../RULES.md#2-repository-boundaries) Catalogs own versioned provider/model data. <!-- rule:RULES.md:73ab3dfb52e87e24 --> | `repository-layout.test.ts` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R17](../../RULES.md#2-repository-boundaries) Scripts own repository automation. <!-- rule:RULES.md:47ee80829ffb7910 --> | `repository-layout.test.ts` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R18](../../RULES.md#2-repository-boundaries) Styles own tokens and cross-boundary CSS. <!-- rule:RULES.md:b47a0d83e9db750e --> | `check:ui` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R19](../../RULES.md#2-repository-boundaries) third_party owns upstream license texts. <!-- rule:RULES.md:a0fb96148748ae9c --> | `check:licenses` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R20](../../RULES.md#2-repository-boundaries) Docs own durable public engineering guidance. <!-- rule:RULES.md:3e829d2b85c8b918 --> | `repository-layout.test.ts` | Known layout/deployment contracts; choosing the correct owner is judgment. |
| [R21](../../RULES.md#2-repository-boundaries) Add platforms only with a real owner/build; share packages only across stable boundaries. <!-- rule:RULES.md:81ca2a64b8879463 --> | judgment only | Review; no general automated gate. |
| [R22](../../RULES.md#desktop-boundaries) Electron owns native windows, preload, secrets, updater and supervision. <!-- rule:RULES.md:67636161a0c91fb6 --> | judgment only | Ownership is reviewed; no universal import boundary gate. |
| [R23](../../RULES.md#desktop-boundaries) Engine owns headless services, agents, Git, workspaces, PTY and data. <!-- rule:RULES.md:1be743bc1a669047 --> | judgment only | Ownership is reviewed; no universal import boundary gate. |
| [R24](../../RULES.md#desktop-boundaries) Renderer features own product capabilities. <!-- rule:RULES.md:7e390dbc653ed132 --> | judgment only | Ownership is reviewed; no universal import boundary gate. |
| [R25](../../RULES.md#desktop-boundaries) Renderer shell composes app chrome and workbench. <!-- rule:RULES.md:f11e70eced85ff5c --> | judgment only | Ownership is reviewed; no universal import boundary gate. |
| [R26](../../RULES.md#desktop-boundaries) Renderer platform owns native/bridge/browser boundaries. <!-- rule:RULES.md:767a47486bdd56c4 --> | judgment only | Ownership is reviewed; no universal import boundary gate. |
| [R27](../../RULES.md#desktop-boundaries) Renderer state owns cross-feature state and lifecycle. <!-- rule:RULES.md:05da96f1bcd0c5ad --> | judgment only | Ownership is reviewed; no universal import boundary gate. |
| [R28](../../RULES.md#desktop-boundaries) Shared renderer code is feature-neutral and cannot import features or shell. <!-- rule:RULES.md:2441dacf183e0198 --> | `repository-layout.test.ts` | The layout test scans shared-source imports. |
| [R29](../../RULES.md#desktop-boundaries) Colocate feature code; use domain kebab-case names and deliberate barrels. <!-- rule:RULES.md:e0e4cecb338f6b6e --> | `repository-layout.test.ts` | Known barrel migrations are checked; naming and new ownership choices are judgment. |
| [R30](../../RULES.md#3-ui-and-styling) Preserve the desktop visual contract and use the normative design guide. <!-- rule:RULES.md:6ab4a340b3e691c2 --> | `check:ui` | Scanned tokens/classes and contrast; visual intent and approval remain judgment. |
| [R31](../../RULES.md#tokens-and-cascade) Generate primitive CSS; consume semantic aliases and preserve cascade contracts. <!-- rule:RULES.md:d6920596ab15bdf4 --> | `check:tokens`, `check:ui` | Generated values and scanned policy; authored import-order semantics need review. |
| [R32](../../RULES.md#tokens-and-cascade) Use semantic tokens/primitives rather than raw palette or arbitrary feature values. <!-- rule:RULES.md:a222feb1b0820db9 --> | `check:ui` | The policy scanner and compiled-class check cover registered source surfaces. |
| [R33](../../RULES.md#tokens-and-cascade) Declare every contrast pairing and meet both-theme role floors. <!-- rule:RULES.md:083c86e43b3bb52d --> | `check:ui` | Declared contrast contract; reviewers must identify missing pairings. |
| [R34](../../RULES.md#tokens-and-cascade) Add a token only with its first caller and regenerate design docs. <!-- rule:RULES.md:179b4f68426d3abf --> | `check:tokens`, `check:ui` | Generated values are checked; first-caller necessity is judgment. |
| [R35](../../RULES.md#tokens-and-cascade) Keep feature styling local; global rules require a cross-owner reason. <!-- rule:RULES.md:c2261af10100c45d --> | `check:ui` | Scanned global policy; exceptional ownership/reason still needs review. |
| [R36](../../RULES.md#component-rules) Reuse and extend shared UI primitives instead of duplicating controls. <!-- rule:RULES.md:d797ef55b241ddea --> | `check:ui` | Known raw-control patterns are scanned; behavioral duplication is judgment. |
| [R37](../../RULES.md#component-rules) Keep raw visual values at real boundaries and explain non-obvious exceptions. <!-- rule:RULES.md:df09ac8c8251438e --> | `check:ui` | Registered policy exceptions; validity of the reason is reviewed. |
| [R38](../../RULES.md#component-rules) Use CSS for hover/focus; inline styles carry dynamic values. <!-- rule:RULES.md:aa8b635b1bc8f159 --> | `check:ui` | Scanned static visual declarations; dynamic behavior needs review. |
| [R39](../../RULES.md#component-rules) Use named overlay layers and shared primitives. <!-- rule:RULES.md:2fd9030d9f768dd8 --> | `check:ui` | Layer policy is scanned; visual stacking still needs interaction checks. |
| [R40](../../RULES.md#component-rules) Keep control sizing, accessible names, focus, keyboard, motion and hidden inertness. <!-- rule:RULES.md:790d7003d2a5de18 --> | `check:ui`, `test:ui-smoke` | Scanned sizing/contrast and smoke scenarios; complete accessibility needs review. |
| [R41](../../RULES.md#enforcement) Keep UI debt shrinking; never bypass policy or loosen contrast to pass. <!-- rule:RULES.md:573d594dc5d598a4 --> | `check:ui` | Ratchet and contrast checks; reviewed exception intent is judgment. |
| [R42](../../RULES.md#enforcement) Check UI changes and rebuild when cascade or renderer entry can change. <!-- rule:RULES.md:3cbcba98b21daf46 --> | `check:ui`, `build:ui` | Commands check their artifacts; invoking the right extra gate is judgment. |
| [R43](../../RULES.md#agent-tool-transcripts) Apply the tool-presentation contract to provider and transcript work. <!-- rule:RULES.md:d6e8b21dc410e504 --> | `native-tool-presentation.test.ts`, `test:ui-smoke` | Known presentation cases; new provider events need their own regression. |
| [R44](../../RULES.md#agent-tool-transcripts) Preserve native tool identity through streaming, completion, history and replay. <!-- rule:RULES.md:e9c97b9e1f8b2048 --> | `history-message-identity.test.ts`, `native-tool-presentation.test.ts` | Covered identities; matching text alone never proves duplicate native calls. |
| [R45](../../RULES.md#agent-tool-transcripts) Wait for usable tool identity, retain provisional rows, and show terminal errors. <!-- rule:RULES.md:b114e82a2dceed87 --> | `native-tool-presentation.test.ts`, `tool-presentation.test.ts` | Known provisional/error rendering cases and color policy. |
| [R46](../../RULES.md#agent-tool-transcripts) Use one bounded expanded tool surface; keep content readable and share edit diffs. <!-- rule:RULES.md:ffaaa4e225234e0e --> | `tool-presentation.test.ts`, `test:ui-smoke` | Covered tool controls; readability and new tools still need review. |
| [R47](../../RULES.md#agent-tool-transcripts) Preserve native child lifetime/report order and bounded live-prose presentation. <!-- rule:RULES.md:99869739073db79c --> | `native-tool-presentation.test.ts`, `test:ui-smoke` | Presentation/smoke cases are partial; provider upgrades need native replay coverage. |
| [R48](../../RULES.md#4-renderer-state-and-interaction-performance) Publish complete route and destination identity in one transition. <!-- rule:RULES.md:e4b91bcc9685ebb5 --> | `navigation-memory.test.ts`, `workspace-cache-transitions.test.ts` | Existing navigation transitions; newly added owners need equivalent races. |
| [R49](../../RULES.md#4-renderer-state-and-interaction-performance) Restore, validate, bound and prune durable semantic-owner selections. <!-- rule:RULES.md:7661fd7b3ea0a556 --> | `navigation-memory.test.ts` | Recorded navigation and nested-owner cases; other durable stores need coverage. |
| [R50](../../RULES.md#4-renderer-state-and-interaction-performance) Prune descendant cwd keys without crossing a registered nested owner. <!-- rule:RULES.md:60d3339cb4c162e2 --> | `navigation-memory.test.ts` | Nested repository and deleted-workspace cases. |
| [R51](../../RULES.md#4-renderer-state-and-interaction-performance) Deduplicate keyed reads and retain the last confirmed exact-key snapshot. <!-- rule:RULES.md:defa700b7567f140 --> | `keyed-async-cache.test.ts`, `workspace-cache-transitions.test.ts` | Shared cache and workspace transitions; new consumers need their own race coverage. |
| [R52](../../RULES.md#4-renderer-state-and-interaction-performance) Warm on pointer/focus intent; urgent clicks do not await I/O. <!-- rule:RULES.md:b4e549af3b400140 --> | judgment only | No general lint or test proves all click paths are free of waits. |
| [R53](../../RULES.md#4-renderer-state-and-interaction-performance) Reuse aggregates and stable selector/collection references; avoid waterfalls. <!-- rule:RULES.md:23c521871b7a511a --> | `read-caches.test.ts`, `keyed-async-cache.test.ts` | Shared reads only; hot consumers and per-row request cost need review. |
| [R54](../../RULES.md#4-renderer-state-and-interaction-performance) Bound retained surfaces and keep hidden effects, focus, shortcuts and polling inert. <!-- rule:RULES.md:8dad23dc85321c86 --> | `pane-portal-store.test.ts`, `local-hidden-chat-preparation.test.ts` | Portal retention and hidden chat preparation; each added effect needs review. |
| [R55](../../RULES.md#4-renderer-state-and-interaction-performance) Fix waterfalls at their source; busy affordances represent genuine cold work. <!-- rule:RULES.md:d0eb30074c423e78 --> | judgment only | No general static check distinguishes real latency from a concealed waterfall. |
| [R56](../../RULES.md#4-renderer-state-and-interaction-performance) Test exact-key isolation, stale races, stability, eviction and A-to-B-to-A restoration. <!-- rule:RULES.md:b4c77cda34ebe843 --> | `keyed-async-cache.test.ts`, `workspace-cache-transitions.test.ts` | Existing shared scenarios; every changed owner boundary is still reviewed. |
| [R57](../../RULES.md#4-renderer-state-and-interaction-performance) Use the interaction-performance guide for detailed examples. <!-- rule:RULES.md:5ce6aa05c01a0ee5 --> | judgment only | Review; no general automated gate. |
| [R58](../../RULES.md#5-security-and-privacy) Keep credentials and private data out of the repository and examples. <!-- rule:RULES.md:5f4fada04698de8d --> | `check:secrets`, `CI secret scan` | Literal/encoded patterns and commit-range scan; sensitive context needs judgment. |
| [R59](../../RULES.md#5-security-and-privacy) Treat VITE values as public; keep secrets in native/server stores. <!-- rule:RULES.md:0b934f364cb22d86 --> | `check:vite-env`, `check:secrets` | Declared environment surface and known secret patterns, not every semantic secret. |
| [R60](../../RULES.md#5-security-and-privacy) Validate network/IPC inputs and authorize normalized filesystem paths. <!-- rule:RULES.md:ac46f677e3751e26 --> | `check:preload`, `check:electron-hardening`, `worker/worker-auth.test.ts` | Allowlist/hardening and worker grants; each new trust boundary needs review/tests. |
| [R61](../../RULES.md#5-security-and-privacy) Treat repositories, providers, links, archives and generated HTML as untrusted. <!-- rule:RULES.md:ffd63950cc18e2cb --> | `check:electron-hardening`, `check:design-containment`, `design/source-sanitizer.test.ts` | Known Electron/Design containment; other input parsers need targeted tests. |
| [R62](../../RULES.md#5-security-and-privacy) Minimize and scrub diagnostics, analytics, feedback and errors. <!-- rule:RULES.md:7e96493e23f7f608 --> | `check:secrets` | Repository scan only; runtime redaction and each new field need review. |
| [R63](../../RULES.md#5-security-and-privacy) Gate internal surfaces and hotkeys on staff authorization plus the feature flag. <!-- rule:RULES.md:1060ef5117e92b8d --> | `internal-features.test.ts`, `check:ui` | Gate semantics and scanned uses; dynamic surfaces still need review. |
| [R64](../../RULES.md#5-security-and-privacy) Preserve authentication, signing, channel isolation, RLS and redaction. <!-- rule:RULES.md:06d49acc5aa53ad5 --> | `check:electron-hardening`, `worker/worker-auth.test.ts`, `cloud/source-authority.test.ts` | Selected trust boundaries; no single gate covers the full security rule. |
| [R65](../../RULES.md#6-public-repository-and-legal-hygiene) Preserve licenses/notices and regenerate the complete third-party inventory. <!-- rule:RULES.md:8396971749eaefab --> | `check:licenses` | Resolved dependency notices; provenance and required source headers still need review. |
| [R66](../../RULES.md#6-public-repository-and-legal-hygiene) Preserve licenses/notices and regenerate the complete third-party inventory. <!-- rule:RULES.md:72e307ca56a2389f --> | `check:licenses` | Resolved dependency notices; provenance and required source headers still need review. |
| [R67](../../RULES.md#6-public-repository-and-legal-hygiene) Verify provenance/license before copying code, assets, text or designs. <!-- rule:RULES.md:e0bcc352c08d301f --> | judgment only | Review; no general automated gate. |
| [R68](../../RULES.md#6-public-repository-and-legal-hygiene) Keep generated/vendor code explicit, pinned, attributed and reproducible. <!-- rule:RULES.md:0a9fa4a11aed7064 --> | `check:licenses` | Registered notices only; directory/pin/generator completeness is judgment. |
| [R69](../../RULES.md#6-public-repository-and-legal-hygiene) Review missing, ambiguous, incompatible or restricted dependency licenses. <!-- rule:RULES.md:f69fbcf9b659ff65 --> | `check:licenses` | Registered license graph is checked; legal compatibility and approval are judgment. |
| [R70](../../RULES.md#6-public-repository-and-legal-hygiene) Keep public artifacts free of private data and unrelated product comparisons. <!-- rule:RULES.md:3b15e858ed1ee3ce --> | `check:secrets`, `CI secret scan` | Sensitive patterns only; relevance and disclosure context are judgment. |
| [R71](../../RULES.md#6-public-repository-and-legal-hygiene) Report security issues privately through SECURITY.md. <!-- rule:RULES.md:1462990c62548eb7 --> | judgment only | Review; no general automated gate. |
| [R72](../../RULES.md#7-tests-and-change-discipline) Add and retain a failing regression before fixing a bug. <!-- rule:RULES.md:f42a50c7a26c7884 --> | judgment only | Test existence and red-before-fix chronology are reviewed, not inferred from CI green. |
| [R73](../../RULES.md#7-tests-and-change-discipline) Run the required baseline and adjacent suites before handoff. <!-- rule:RULES.md:101df16102efcba4 --> | `zstack/verify.mjs`, `CI quality` | Selector and selected CI gates enforce their recipes; local execution timing is judgment. |
| [R74](../../RULES.md#7-tests-and-change-discipline) Run all applicable targeted gates. <!-- rule:RULES.md:64f8b72599d347f9 --> | `zstack/verify.mjs`, `CI scope` | Shared path registry selects checks; extra task-specific scope is judgment. |
| [R75](../../RULES.md#7-tests-and-change-discipline) Run browser smoke and a UI build after interaction/overlay work. <!-- rule:RULES.md:b16e2daed7709dda --> | `test:ui-smoke`, `build:ui` | Harness/build coverage; changed interactions need appropriate scenarios. |
| [R76](../../RULES.md#7-tests-and-change-discipline) Run preload validation and Electron tests after IPC/preload changes. <!-- rule:RULES.md:f057c57be761af69 --> | `check:preload` | The allowlist gate is automated; selecting relevant native tests is judgment. |
| [R77](../../RULES.md#7-tests-and-change-discipline) Run engine lifecycle smoke on macOS. <!-- rule:RULES.md:7be5ffe7f533ef3c --> | `smoke:engine` | Requires macOS; a Linux run supplies no native lifecycle proof. |
| [R78](../../RULES.md#7-tests-and-change-discipline) Test and typecheck the control plane independently. <!-- rule:RULES.md:eb4601db299d7b0e --> | `test:control-plane`, `control-plane:typecheck` | Database-backed suites also need their PostgreSQL fixture. |
| [R79](../../RULES.md#7-tests-and-change-discipline) Validate changed workflow definitions. <!-- rule:RULES.md:55fbe761336b93f6 --> | `check:actions` | Actionlint and concurrency validation; CI definitions still require owner merge. |
| [R80](../../RULES.md#7-tests-and-change-discipline) Run matching migration, packaging, protocol, deep-link and deployment gates. <!-- rule:RULES.md:118f3a109751ae35 --> | `check:migrations`, `check:control-plane-migrations`, `check:packaging-paths`, `check:protocol`, `check:deep-link-schemes`, `check:web-deploy` | Each validates its named contract; deployment behavior needs applicable live checks. |
| [R81](../../RULES.md#7-tests-and-change-discipline) Check licenses after dependency, generated-code or packaged-asset changes. <!-- rule:RULES.md:e308066b41057772 --> | `check:licenses` | Audited graphs/notices only; provenance still needs human review. |
| [R82](../../RULES.md#7-tests-and-change-discipline) Report a platform-only check as unverified unless run on that platform. <!-- rule:RULES.md:1c439a8c961d31f3 --> | judgment only | Receipts show the host; interpreting or overstating evidence remains judgment. |
| [R83](../../RULES.md#7-tests-and-change-discipline) Update durable docs when boundaries, commands, deployments or ownership change. <!-- rule:RULES.md:164786006eaef41a --> | `design-system-docs.test.ts`, `check:ui` | Generated briefs only; prose completeness is judgment. |
| [R84](../../RULES.md#8-local-and-cloud-workspaces) Handle Local Personal, organization-local and cloud owners and placements. <!-- rule:RULES.md:6c712906c6e02c5e --> | `test:workspace-lifecycle`, `workspace-cache-transitions.test.ts` | Covered lifecycle/switching paths only; each changed feature needs placement review. |
| [R85](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Handle Local Personal, organization-local and cloud owners and placements. <!-- rule:RULES.md:9fedb323d833598f --> | `test:workspace-lifecycle`, `workspace-cache-transitions.test.ts` | Covered lifecycle/switching paths only; each changed feature needs placement review. |
| [R86](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Distinguish the Local Personal owner from collaborative tenant organizations. <!-- rule:RULES.md:41a428806184f027 --> | `navigation-memory.test.ts`, `workspace-cache-transitions.test.ts` | Owner routing and switching fixtures; new tenant APIs need authorization tests. |
| [R87](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Allow local placements for either owner; cloud uses its own standalone VM worker. <!-- rule:RULES.md:3b33071ed46977a1 --> | `worker/runtime-boundary.test.ts`, `project-capabilities.test.ts` | Worker import boundary and placement capabilities. |
| [R88](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Use cloud keys as renderer identity and reject foreign VM-native roots. <!-- rule:RULES.md:ba92ec779cf77885 --> | `cloud-workspace-key.test.ts` | Typed key parsing; every wire path translation needs adjacent tests. |
| [R89](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) State every placement's behavior and include Local/Cloud impact sections in PRs. <!-- rule:RULES.md:1ee584b207d8c3e6 --> | `agent:merge` | Six visible Markdown headings on human/agent PRs; bots retain their body policy. Impact accuracy is review. |
| [R90](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Select cloud behavior at its typed owning boundary, without changing Local incidentally. <!-- rule:RULES.md:e20ea8b5cd662d28 --> | `worker/runtime-boundary.test.ts`, `project-capabilities.test.ts` | Known boundary/capability paths; shared callers require both-placement review. |
| [R91](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Test both placements or prove Local unchanged; document unavailable live checks. <!-- rule:RULES.md:62adf54906bb9bf4 --> | judgment only | No static gate proves a selected suite exercises both placements. |
| [R92](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Keep cloud lifecycle states and archive/restore/idle semantics distinct. <!-- rule:RULES.md:63c4c3967391c91b --> | `cloud/lifecycle.test.ts`, `cloud/routes.test.ts` | Lifecycle/routes fixtures; rendering and deployed transitions need their own proof. |
| [R93](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Read passive cloud history without waking; explicit work/activity controls VM lifetime. <!-- rule:RULES.md:943d3164e3a5fe4e --> | `cloud/history.integration.test.ts`, `cloud/lifecycle.test.ts` | Mirror and lifecycle coverage; true VM stop/wake is a live check. |
| [R94](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Keep cloud infrastructure/login authority server-side and broker provider/GitHub access. <!-- rule:RULES.md:5fd4c04e6eb32ef1 --> | `cloud/composition.test.ts`, `cloud/github-selected-tokens.test.ts`, `cloud/worker-auth.test.ts` | Provider delivery, scoped GitHub tokens and worker grants; account setup is operator judgment. |
| [R95](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Treat the VM as one trust domain; stock non-root user and session paths are not isolation. <!-- rule:RULES.md:c6297ab463d0f971 --> | `cloud/runtime.test.ts`, `worker/runtime-boundary.test.ts` | Generated runtime/user and import boundaries; actual Boat image needs live proof. |
| [R96](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Enforce creator membership/source access and organization-admin Cloud Computer control. <!-- rule:RULES.md:afb06839f2a6e39c --> | `cloud/source-authority.test.ts`, `cloud/routes.test.ts` | Server authorization fixtures; multi-device/live-provider behavior needs integration proof. |
| [R97](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Install the SHA-pinned runtime on create/wake; build clean before source/credentials. <!-- rule:RULES.md:aa13d35169bf418f --> | `cloud/runtime.test.ts`, `cloud/source-authority.test.ts` | Generated delivery/source-scope paths; real image boot/checkpoint needs live proof. |
| [R98](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Cloud exposes chat/files/Git/terminals, with no Browser/Design/simulator fallback to Local. <!-- rule:RULES.md:3d30cf2aa69c77d4 --> | `project-capabilities.test.ts`, `worker/runtime-boundary.test.ts` | Capability model and worker boundary; new surfaces need their own gate tests. |
| [R99](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Keep the control plane standalone; mirror protocol contracts and test parity. <!-- rule:RULES.md:ed2b943a1e100f30 --> | `control-plane:typecheck`, `worker/contract-parity.test.ts` | Standalone types and mirrored wire fields; new cross-package imports require review. |
| [R100](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Keep eligible Local features working offline and without a signed-in account. <!-- rule:RULES.md:d8a00959b3c24256 --> | `test:workspace-lifecycle` | Local lifecycle fixtures; network independence of new features is judgment. |
| [R101](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Keep Local worktrees, credentials and restart/respawn recovery on the Mac. <!-- rule:RULES.md:419e966c1e7e139d --> | `test:workspace-lifecycle`, `smoke:engine` | Unit lifecycle plus macOS-only runtime proof. |
| [R102](../../RULES.md#agent-brief-local-and-cloud-workspaces-in-zeros) Key reads by exact owner/placement/workspace and fence late replies at completion. <!-- rule:RULES.md:d9d94e48f18e4b57 --> | `workspace-cache-transitions.test.ts`, `keyed-async-cache.test.ts` | Shared cache/switching fixtures; each async consumer needs equivalent fences. |

## Named enforcers

Locations are relative to the repository root; # identifies a package script or
a workflow job. CI lanes run only under the repository's existing scope policy.

| Enforcer | Kind | Location |
| --- | --- | --- |
| `CI quality` | CI lane | `.github/workflows/ci.yml#quality` |
| `CI scope` | CI lane | `.github/workflows/ci.yml#scope` |
| `CI secret scan` | CI lane | `.github/workflows/ci.yml#secret-scan` |
| `agent:check` | script | `package.json#agent:check` |
| `agent:merge` | script | `package.json#agent:merge` |
| `build:ui` | script | `package.json#build:ui` |
| `check:actions` | script | `package.json#check:actions` |
| `check:control-plane-migrations` | script | `package.json#check:control-plane-migrations` |
| `check:deep-link-schemes` | script | `package.json#check:deep-link-schemes` |
| `check:design-containment` | script | `package.json#check:design-containment` |
| `check:electron-hardening` | script | `package.json#check:electron-hardening` |
| `check:licenses` | script | `package.json#check:licenses` |
| `check:migrations` | script | `package.json#check:migrations` |
| `check:packaging-paths` | script | `package.json#check:packaging-paths` |
| `check:preload` | script | `package.json#check:preload` |
| `check:protocol` | script | `package.json#check:protocol` |
| `check:secrets` | script | `package.json#check:secrets` |
| `check:tokens` | script | `package.json#check:tokens` |
| `check:ui` | script | `package.json#check:ui` |
| `check:vite-env` | script | `package.json#check:vite-env` |
| `check:web-deploy` | script | `package.json#check:web-deploy` |
| `ci:plan` | script | `package.json#ci:plan` |
| `cloud-workspace-key.test.ts` | test | `apps/desktop/src/renderer/platform/bridge/__tests__/cloud-workspace-key.test.ts` |
| `cloud/composition.test.ts` | test | `apps/control-plane/src/cloud/composition.test.ts` |
| `cloud/github-selected-tokens.test.ts` | test | `apps/control-plane/src/cloud/github-selected-tokens.test.ts` |
| `cloud/history.integration.test.ts` | test | `apps/control-plane/src/cloud/history.integration.test.ts` |
| `cloud/lifecycle.test.ts` | test | `apps/control-plane/src/cloud/lifecycle.test.ts` |
| `cloud/routes.test.ts` | test | `apps/control-plane/src/cloud/routes.test.ts` |
| `cloud/runtime.test.ts` | test | `apps/control-plane/src/cloud/runtime.test.ts` |
| `cloud/source-authority.test.ts` | test | `apps/control-plane/src/cloud/source-authority.test.ts` |
| `cloud/worker-auth.test.ts` | test | `apps/control-plane/src/cloud/worker-auth.test.ts` |
| `control-plane:typecheck` | script | `apps/control-plane/package.json#typecheck` |
| `design-system-docs.test.ts` | test | `scripts/__tests__/design-system-docs.test.ts` |
| `design/agent-drafts.test.ts` | test | `apps/desktop/src/engine/design/__tests__/agent-drafts.test.ts` |
| `design/manifest.test.ts` | test | `apps/desktop/src/engine/design/__tests__/manifest.test.ts` |
| `design/source-sanitizer.test.ts` | test | `apps/desktop/src/engine/design/__tests__/source-sanitizer.test.ts` |
| `git/diff.test.ts` | test | `apps/desktop/src/engine/git/__tests__/diff.test.ts` |
| `history-message-identity.test.ts` | test | `apps/desktop/src/renderer/features/agent/__tests__/history-message-identity.test.ts` |
| `internal-features.test.ts` | test | `apps/desktop/src/renderer/features/settings/__tests__/internal-features.test.ts` |
| `keyed-async-cache.test.ts` | test | `apps/desktop/src/renderer/state/__tests__/keyed-async-cache.test.ts` |
| `local-hidden-chat-preparation.test.ts` | test | `apps/desktop/src/renderer/shell/conversation/__tests__/local-hidden-chat-preparation.test.ts` |
| `native-tool-presentation.test.ts` | test | `apps/desktop/src/renderer/features/agent/__tests__/native-tool-presentation.test.ts` |
| `navigation-memory.test.ts` | test | `apps/desktop/src/renderer/state/__tests__/navigation-memory.test.ts` |
| `pane-portal-store.test.ts` | test | `apps/desktop/src/renderer/shell/conversation/__tests__/pane-portal-store.test.ts` |
| `project-capabilities.test.ts` | test | `apps/desktop/src/renderer/state/__tests__/project-capabilities.test.ts` |
| `read-caches.test.ts` | test | `apps/desktop/src/renderer/state/__tests__/read-caches.test.ts` |
| `repository-layout.test.ts` | test | `scripts/__tests__/repository-layout.test.ts` |
| `smoke:engine` | script | `package.json#smoke:engine` |
| `test:control-plane` | script | `package.json#test:control-plane` |
| `test:ui-smoke` | script | `package.json#test:ui-smoke` |
| `test:workspace-lifecycle` | script | `package.json#test:workspace-lifecycle` |
| `tool-presentation.test.ts` | test | `apps/desktop/src/renderer/features/agent/__tests__/tool-presentation.test.ts` |
| `worker/contract-parity.test.ts` | test | `apps/cloud-worker/src/__tests__/contract-parity.test.ts` |
| `worker/runtime-boundary.test.ts` | test | `apps/cloud-worker/src/__tests__/runtime-boundary.test.ts` |
| `worker/worker-auth.test.ts` | test | `apps/cloud-worker/src/__tests__/worker-auth.test.ts` |
| `workspace-cache-transitions.test.ts` | test | `apps/desktop/src/renderer/state/__tests__/workspace-cache-transitions.test.ts` |
| `zstack.test.ts` | test | `scripts/__tests__/zstack.test.ts` |
| `zstack/verify.mjs` | script | `scripts/zstack/verify.mjs` |
