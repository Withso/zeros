# ZSR Instant Sessions — diagnosis, research, and target architecture

**Status:** superseded historical research, retained for its measurements and
decision record. The private-world architecture described below is no longer a
plan of record and its file/line references intentionally name removed code.
The current contracts are
[zeros-sandbox-runtime-plan.md](zeros-sandbox-runtime-plan.md) and
[zeros-sandbox-runtime-qualification.md](zeros-sandbox-runtime-qualification.md).

**2026-08-28 follow-up:** interactive cold create/resume now returns after the
immutable kernel policy/process domain is established and runs its behavioral
canary and fresh territory revalidation concurrently with provider startup.
Warm spares remain pre-attested when the diagnostic switch enables them, but
speculative session-spare preparation is off by default after live traces found
it competing with the first provider turn for seconds to save at most a few
hundred milliseconds later. Setup, Run, and utilities remain blocking. A failed
background proof stops only that exact tree and reports
`design-protection-failed`. Failed teardown proof is also exact-scoped and
retried; it no longer trips a process-wide admission latch. The historical
canary-before-provider and global-latch proposals below are not current
contracts.

The first prompt is also cancellable throughout this window. It is rendered as
the live turn with a continuous timer and Stop control while admission is still
pending. Stop aborts the chat-scoped create/resume rather than sending a cancel
to a provider session that does not exist, and a later prompt starts a new
single-flight admission without waiting for the cancelled preparation.

This report analyzed the 2026-08-17 implementation: preflight admission,
provider-HOME copies, shadow Git, credential projection, network/port brokers,
and per-agent resource controls. It uses working-tree references from that
snapshot. External claims carry source URLs. Numbers are marked **measured**
(from logs/benches/papers) or **estimated** (arithmetic from measured parts).

## 2026-08-19 resolution: sessions no longer build a private world

The product contract changed after the measurements in this report. ZSR now
owns actor-scoped Design/code write authority, immutable engine-control state,
process-domain teardown, a narrow trusted whole-tree Git integration broker,
and dedicated container capability. Local and cloud sessions no longer create
a private HOME, shadow Git, credential projection, network/port/service broker,
or per-agent cgroup. Cloud uses the tenant VM as its network, credential, and
resource boundary.

For local code sessions, native Git and the original HOME/GH/SSH/Keychain and
network environment pass through unchanged while every recognized Design root
is write-denied. The inverse design actor makes repository code read-only,
reopens all Design roots, and reopens minimal canonical Git metadata directories
so Git can atomically replace its index and refs. The packaged Linux canary
measured complete admissions at roughly 0.4 seconds. The synchronized
Apple-silicon Mac measured 756 ms for code and 202 ms for design. Both passed
with `secure: true`.

This makes the earlier remaining private-world performance tasks no-ops:

- Task #13's dispatcher is bypassed entirely rather than optimized further.
- Boot refill depth does not affect local admission because local sessions do
  not consume provider worlds.
- The two-phase canary is unnecessary for the stated under-one-second target;
  the remaining exact write-fence canary is already below it.
- OrbStack workers are keyed and reference-counted per workspace instead of per
  chat, with a credential-free stable control root.

The queue/private-world numbers below remain valid historical evidence for the
removed profile; they are not the cost model of any current runtime path.

---

## 0. Executive summary

**Is it queueing? Yes — queueing is now most of it.** In this morning's boot log,
the worst admission spent **30.8 s in queue for 1.06 s of actual work**
(`admitted cursor in 31823ms (queue=30759ms … canary=768ms)`). Of the 14 admissions
in that log, at most 3 were messages the user sent; the rest were boot rehydration,
provider probes, chat titles, and an engine self-probe — squeezed through a 2-slot
gate, several of them at the wrong priority.

**Is ZSR a cloud sandbox? No.** There is no VM, no network hop, no image pull, and
nothing "reboots". The isolation fence itself — Seatbelt on macOS, bubblewrap on
Linux — costs single-digit **milliseconds** (measured: `bwrap` adds ~5 ms; Bazel and
Chromium benchmarks exonerate `sandbox-exec`; see §4.1). What costs seconds is the
**private world each session gets**: a copied provider HOME (four full tree
traversals plus a per-file copy, even warm), a private shadow Git (~45 `git`
subprocesses per repository), and a live enforcement canary (two cold Node spawns +
a `git` spawn) — all built serially, at send time, once per admission, times too
many admissions.

**Can it feel exactly like before ZSR? Yes, by construction.** "Before ZSR" was
never zero-latency — provider boot (Claude SDK / Codex app-server / Cursor host)
existed then and still dominates the floor. What made it _feel_ instant was:
(a) the message was **accepted immediately** (composer cleared, active turn and
elapsed timer visible), and
(b) there was **no admission in front of it**. Both are recoverable without
weakening one guarantee, using the same patterns every fast system in industry
uses (§4): build the expensive state **ahead of need**, keep refresh **O(changes)
not O(files)**, **reuse instead of rebuild**, keep proofs but make them cheap, and
never put background work in front of a person.

**The plan in one line:** _park worlds, not boundaries_ — prewarm the expensive,
env-independent session world (HOME overlay + shadow git) in the background, and at
send time run only the thin env-dependent layer (policy, leases, tokens, process
domain) against it, while the already-fenced execution and its live behavioral
attestation start together. Target end state (estimated): **send accepted &lt; 100 ms
always; engine-side session ready ~0.3–0.6 s on a pool hit (fully overlapped with
typing → perceived ~0); ~1–1.5 s on a miss; provider boot unchanged (the pre-ZSR
floor)**. Isolation is unchanged: the same kernel policy is installed before any
provider byte, the canary runs concurrently and stops that exact execution on
failure, teardown remains proven, and generation anti-replay remains fail-closed.

---

## 1. Evidence: what today's log actually shows

Source: the 2026-08-17 07:41 boot log (dev instance, Apple-silicon Mac), read
against the working tree.

### 1.1 The queue is the tail

| Admission                   |         Total |         Queue | Actual stage work |
| --------------------------- | ------------: | ------------: | ----------------: |
| `generic` (boot self-probe) |      6,410 ms |             0 |          6,410 ms |
| `codex` (auth probe)        |      5,151 ms |             0 |          5,151 ms |
| `claude`                    |     10,644 ms |        586 ms |         10,058 ms |
| `cursor`                    |     10,139 ms |      1,719 ms |          8,420 ms |
| `codex`                     |     17,005 ms |      8,251 ms |          8,754 ms |
| `codex`                     |     14,394 ms |      6,454 ms |          7,940 ms |
| `claude`                    |     13,868 ms |      6,388 ms |          7,480 ms |
| `codex`                     |     19,971 ms |     11,472 ms |          8,499 ms |
| `codex`                     |     20,335 ms |     10,918 ms |          9,417 ms |
| `cursor`                    |     17,569 ms |      8,539 ms |          9,030 ms |
| **`cursor`**                | **31,823 ms** | **30,759 ms** |      **1,064 ms** |
| `codex`                     |     11,338 ms |      7,677 ms |          3,661 ms |
| `codex`                     |      8,676 ms |      4,965 ms |          3,711 ms |
| `codex` (quiet, solo)       |      2,847 ms |             0 |          2,847 ms |

Measured totals: **~97.7 s of queue wait** across 11 queued admissions, ~92.4 s of
stage work across all 14. A quiet solo admission is **~2.4–2.8 s** (2,847 ms here;
2,417 ms minimum in the qualification ledger's 18-admission sample). Under the
burst, per-admission stage work inflates ~2.5× (avg ~6.6 s) — the herd starves
itself on CPU/IO even inside a 2-slot gate.

### 1.2 The demand is mostly not the user

Census of every path that can admit (each verified,
`apps/desktop/src/engine/agents/gateway.ts` unless noted):

| Path                                                | Trigger                                                                               | Priority today                                                   | Shape                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| `newSession` (`:3253`)                              | user send / chat open                                                                 | interactive                                                      | long-lived                                   |
| `loadSession` (`:3462`)                             | chat reopen / app boot per surfaced chat                                              | interactive                                                      | long-lived                                   |
| `forkProviderBinding` (`:3689`)                     | explicit fork                                                                         | interactive                                                      | one-shot                                     |
| `generateTitle` (`:3100`)                           | first settled prompt per chat                                                         | background                                                       | **full prepare + proven teardown per title** |
| `runProviderOneShot` (`:2986`)                      | key validation, `listSessions`                                                        | background                                                       | one-shot                                     |
| provider probes (`:2752`)                           | every un-cached `listAgents`                                                          | background                                                       | one-shot per provider                        |
| repo tasks (`containment/repo-task-boundary.ts:84`) | **engine boot login-shell PATH probe** (`zeros-engine.ts:917`), Setup, Run, git hooks | **interactive — never set** (defaults at `zsr-boundary.ts:3094`) | one-shot                                     |

At boot, before the user does anything: `listAgents` probes (≤1 per provider), a
full `loadSession` admission **per surfaced chat** (the ChatDeck mounts up to 12
panes; each persisted binding re-admits), the interactive `generic` login-shell
probe, and shortly after, one title admission per newly-titled chat. That is the
whole burst in §1.1. Two defects fall straight out:

- **Bug 1:** `repo-task-boundary.ts` never sets `admissionPriority`, so the boot
  PATH probe (and every Setup/Run/git-hook boundary) admits as _interactive_ and
  cannot be jumped by a real user session — the exact case the gate's priority
  classes were built to prevent.
- **Bug 2:** `AGENT_PREFLIGHT` has no renderer caller left
  (`session-admission-policy.ts:7` says so) but the engine RPC still prepares a
  real boundary + proven teardown if anything ever calls it. Dead weight to remove.

### 1.3 Where a solo admission spends its ~2.5 s

The stage recorder is a moving cursor (`zsr-boundary.ts:3110-3118`) — stages sum to
the total. The pipeline is serial by construction with exactly **one** overlap
(shadow git starts inside the overlay window, `zsr-boundary.ts:3443-3457`;
`private-git` reports only the residual). Everything else awaits in a line:

```
probe (cached ≈0) → discover (~70–250ms) → [git-broker ports + OrbStack reserve +
policy ~5–220ms] → provider-state: port pool + tool copies + HOME overlay
(~0.4–2.2s) ∥ shadow git (~45 git spawns/repo) → private-git residual (0–0.8s) →
process-domain (~6ms) → canary (~0.6–1.7s, two Node spawns + git spawn + handshake)
```

Three structural facts (from the working tree):

1. **The overlay is O(files) even when warm.** The ctime-keyed digest manifest
   eliminates re-_hashing_, not re-_walking/copying_: every admission does four
   full traversals (host snapshot, durable snapshot, copy pass, local baseline)
   plus per-file `mkdir`+`copyFile(FICLONE)`+`chmod`+`lstat`
   (`provider-home-overlay.ts:2026-2418`, `:927-947`). Bytes are CoW-free on APFS;
   syscalls × file-count are the cost.
2. **Shadow git is spawn-bound.** `initialize()` runs ~45 `git` subprocesses per
   repository — including one `git config` spawn _per config entry_
   (`shadow-git.ts:901-923`) and one `reflog show` per ref (`:3090-3205`) — and
   repositories are built serially (`shadow-git-collection.ts:351-380`). Objects
   are already shared via alternates (no copy); the spawns are the cost.
3. **The canary is process-spawn-bound and uncached by design.** It spawns the
   real supervisor → Seatbelt/bwrap → `node -e` (140-line proof), which itself
   spawns `git rev-parse` per repo and a second Node for the macOS bind-mapping
   probe, then waits on an out-of-band process-domain handshake
   (`zsr-boundary.ts:2260-2668`, `:486-626`). Floor 549 ms in the ledger; ~1.6 s
   solo in today's log. It runs unconditionally on every `admit()` — one call
   site, no memo (`:3622`).

### 1.4 The Cursor "1 m 22 s" is mostly not ZSR

Decomposed previously against the 07:03 log: admission ~7.7 s (contended), then
Cursor's own host boot (`computeGlobalCache: slow … 1079ms` _after_ the prompt was
dispatched — its `.cursor` cache/extensions are excluded from the overlay, so it
rebuilds them per session) plus Grok model time, with nothing streamed until done.
ZSR can shave its share and can consider projecting Cursor's cache, but the bulk of
that specific wait is provider-side. §8 covers what remains ours.

---

## 2. Why "local" ≠ "instant" today — the honest answer

The user-visible question: _"it's not a cloud sandbox, it's local — why does it
take time?"_

Because ZSR's cost was never the sandbox. The kernel fence is milliseconds (§4.1).
The seconds come from what Zeros builds around the fence so that a contained agent
loses **no features** — the parity machinery: a private writable HOME projected
from durable state (so settings/MCP/plugins/auth work), a private shadow Git (so
`git` works without touching canonical state), leased ports/brokers (so dev servers
work), and a behavioral proof that the fence is really enforced _before the first
provider byte_. Each piece is justified; what is not justified is **when and how
often** they run: serially, at send time, per admission, with no reuse between
admissions, and with background work allowed in front of the user.

Pre-ZSR, "send" = spawn provider process with the host HOME. Post-ZSR, "send" =
build a world + prove it + spawn provider. The fix is not to weaken the world or
the proof — it is to stop building the world on the send path. That is exactly the
industry playbook, next.

---

## 3. What a boundary actually needs to exist (and when each part is knowable)

From the working-tree code, the boundary's inputs split cleanly into three classes
(`zsr-boundary.ts`, `policy.ts`, `provider-home-overlay.ts`, `gateway.ts:1849-1877`):

| Class                                              | Contents                                                                                                                                                                                                 | Knowable                                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **(a) Env-independent world** — the expensive part | HOME overlay managed content, compatibility seeds, read-only toolchain links, XDG skeleton, shadow-git dir (refs/index/reflogs/config/hooks/alternates), static tool copies                              | at **workspace open** — pure function of (workspaceRoot, provider, actor, territory generation, providerStateEnv-scope)   |
| **(b) Env-dependent thin layer** — cheap           | policy document (PATH/toolchain read roots, loopback services, container worker), port leases + broker tokens, per-session tool configs, process-domain descriptor, keychain credential seed, generation | only at **send** (renderer resolves provider prefs + MCP secrets + env vault per send, `sessions-provider.tsx:1432-1451`) |
| **(c) Per-session mutable write-back**             | the live private HOME as written by the session, shadow index/objects, promotion back to the durable store under the promotion lock                                                                      | per session, by contract                                                                                                  |

Two verified facts make this split actionable:

- **The projected HOME bytes are executionId-free.** Every executionId/session-path
  leak lives in small regenerable artifacts of layer (b): `policy.json`
  (`policy.ts:580,607`), `git-worktree-entry` (`shadow-git.ts:3678-3683`),
  validator alternates (`:3869-3873`), `git-dispatcher.mjs` / `git-client.mjs`
  (broker host/port/token, `shadow-git-remote-broker.ts:195-212`), process-domain
  marker/metadata (`policy.ts:378`, `macos-process-domain.ts:357-371`), recovery
  hold (`provider-home-overlay.ts:2480`). None of layer (a)'s content embeds them.
- **`executionId` is not an authority token.** The security identity is
  `generation` (fresh UUID per admit, anti-replay — `containment/types.ts:16-21`);
  `executionId` only forms paths and labels. Layer (b) can therefore be rebuilt at
  adoption while layer (a) is reused, without touching the trust story.

The blockers previously recorded against P1 prewarm dissolve under this split: the
env problem (policy derived from per-send env) stops being a blocker because the
env-dependent layer is _always built fresh at adoption_; parked state holds **no
live resources** (no ports, no sockets, no processes, no supervisor), so a parked
item can be reaped with `rm -rf` — no teardown proof, no exposure to the app-wide
retirement latch (`gateway.ts:1996-2004`); and the missing policy digest is only
needed for the world key, which is computable from class-(a) inputs.

---

## 4. What proven systems do (research, with sources)

### 4.1 The fence is never the cost

- `bwrap … ls` measured at **8.04 ms** total vs ~3 ms native (~5 ms overhead) vs
  279–378 ms under Docker/Podman — <https://jvns.ca/blog/2022/06/28/some-notes-on-bubblewrap/>.
  Namespace creation measured at **7.9–8.5 ms, <1.5 %** of container startup —
  <https://arxiv.org/html/2602.15214>.
- macOS Seatbelt: no published ms figure, but Bazel's investigation concluded
  `sandbox-exec` "hasn't been shown to be particularly slow in actual benchmarks"
  (a reported 20× slowdown was clang's module cache, not the wrap) —
  <https://lightrun.com/answers/bazelbuild-bazel-sandbox-slowness-on-osx>,
  <https://jmmv.dev/2025/06/whatever-happened-to-sandboxfs.html>. Chromium compiles
  the profile in-browser and ships it to children with no recorded perf concern —
  <https://chromium.googlesource.com/chromium/src/+/HEAD/sandbox/mac/seatbelt_sandbox_design.md>.
  Known Seatbelt hazard is profile _size_ (Apple's compiler aborts on huge
  path-enumerating profiles, <https://github.com/NixOS/nix/issues/2311>) — keep
  profiles parameterized, which ZSR already does.
- seccomp: ns-scale evaluation, ~1 % of gVisor runtime post-optimization —
  <https://gvisor.dev/blog/2024/02/01/seccomp/>.

**Implication:** per-session Seatbelt/bwrap stays, with a clear conscience.

### 4.2 Template + attach, never rebuild (the cold-start canon)

- **SOCK** (USENIX ATC'18): zygote templates + package cache → **18× over Docker,
  45× with tiered zygote cache**; instantiation "reduces to the cost of a fork()" —
  <https://www.usenix.org/conference/atc18/presentation/oakes>.
- **Catalyzer** (ASPLOS'20): checkpoint + `sfork` reuse of a running sandbox's
  state → **<1 ms best case** — <https://ipads.se.sjtu.edu.cn/pub/projects/catalyzer>.
- **REAP** (ASPLOS'21): snapshot restore is page-fault-bound; record the working
  set once, prefetch it → **3.7× faster cold starts** — <https://arxiv.org/abs/2101.09355>.
- **AWS Lambda SnapStart**: snapshot at _publish time_, tiered chunk cache,
  working-set tracking → "several seconds → sub-second" —
  <https://aws.amazon.com/blogs/compute/under-the-hood-how-aws-lambda-snapstart-optimizes-function-startup-latency/>.
- **Firecracker**: microVM boot ≤125 ms by spec; snapshot restore a few hundred ms
  in production (Fly.io suspend/resume) — <https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md>,
  <https://fly.io/docs/reference/suspend-resume/>.
- **Cloudflare Workers**: isolates start ~100× faster than processes; residual
  cold start hidden inside the TLS handshake ("cold starts eliminated") —
  <https://developers.cloudflare.com/workers/reference/how-workers-works/>,
  <https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/>.
- **AI-agent sandboxes** run this same recipe: E2B "less than 200 ms" (Firecracker
  pools + snapshots, <https://e2b.dev/>), Modal memory snapshots (~2.5× faster
  cold starts; `import torch` 5 s → 1.05 s, <https://modal.com/blog/mem-snapshots>),
  Daytona ~90 ms creates (<https://www.daytona.io/>), Morph VM fork/branch
  <250 ms (<https://cloud.morph.so/docs/developers>).
- **Dev environments**: Codespaces prebuilds took github/github from 45 min to
  **~10 s** by pooling fully-built environments
  (<https://github.blog/2021-08-11-githubs-engineering-team-moved-codespaces/>);
  Gitpod's P95 lesson: per-start data movement is the killer — keep the attach
  payload small (<https://github.com/gitpod-io/gitpod/issues/9018>).

**Implication:** every "instant" system separates **assembly** (async, on change
events) from **attach** (click-time, O(working set)). None of them made per-session
setup fast; they made it _not per-session_.

### 4.3 On macOS specifically: pools, not zygotes; clones, not copies

- fork-without-exec is unsupported on macOS (CoreFoundation "you MUST exec()",
  ObjC post-fork aborts) — <https://www.wefearchange.org/2018/11/forkmacos.rst>,
  <http://www.sealiesoftware.com/blog/archive/2017/6/5/Objective-C_and_fork_in_macOS_1013.html>.
  The viable pattern is Chromium's **spare process** — a live, pre-sandboxed,
  "unlocked" process adopted on demand, discarded on version change —
  <https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md>.
  No CRIU-style process snapshot exists on macOS (CRIU is Linux-only,
  <https://criu.org/Main_Page>).
- APFS `clonefile` per file is ~constant-time (1 GB in 6.9 ms via `cp -c` vs
  260 ms copy — <https://alexwlchan.net/2025/cloning-with-python/>); directory-level
  `clonefile(2)` is Apple-discouraged (kernel locks the source hierarchy;
  ownership reset, setuid stripped) — <https://www.manpagez.com/man/2/clonefile/>,
  <https://mjtsai.com/blog/2026/05/14/apfs-folder-clones/>. Per-file cloning of
  3–10 k files has a hard floor of roughly 0.1 ms/file → **0.3–1 s** — which is why
  pre-cloning must happen off-path, and why _reuse_ beats _re-clone_.
- **Bazel's production answer is reuse**: `--reuse_sandbox_directories` stashes
  sandbox dirs between actions and diffs instead of recreating — "a sizable
  speedup" on macOS — <https://bazel.build/docs/sandboxing>,
  <https://github.com/bazelbuild/bazel/issues/16138>. pnpm's store prefers
  **clone > hardlink > copy** for mutation safety — <https://pnpm.io/settings/node-modules>.
- **Watch-driven manifests** make "what changed" O(changes): Watchman clocks,
  Buck2's "almost instant" no-op builds, Bazel `--watchfs`/FSEvents —
  <https://facebook.github.io/watchman/>, <https://engineering.fb.com/2023/04/06/open-source/buck2-open-source-large-scale-build-system/>.

### 4.4 Amortized verification — precedent and its limits

Precedent for verifying a **template** once and trusting **instances**:
TPM measured boot verifies digests, not per-boot behavior
(<https://learn.microsoft.com/en-us/azure/security/fundamentals/measured-boot-host-attestation>);
Chrome tests its seccomp policies at build/CI time and asserts (not
penetration-tests) attachment at launch
(<https://chromium.googlesource.com/chromium/src/+/lkgr/sandbox/linux/seccomp-bpf>);
the kernel guarantees confinement is inherited and monotonic (seccomp filters
preserved across fork/execve, <https://man7.org/linux/man-pages/man2/seccomp.2.html>;
Landlock "no way to remove its security policy",
<https://docs.kernel.org/userspace-api/landlock.html>). The known failure class of
cloned/restored state is **freshness/uniqueness**, not enforcement: Firecracker
declares double-resume insecure without uniqueness handling
(<https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md>);
Android's zygote cloned identical ASLR layouts to every app (Morula, IEEE S&P'14,
<https://www.ieee-security.org/TC/SP2014/papers/FromZygotetoMorula_c_FortifyingWeakenedASLRonAndroid.pdf>).

**Position taken in this report:** keep the per-admission behavioral canary. ZSR's
canary is cheap to make cheap (§5.3) and the park-worlds design keeps it off the
perceived path, so the amortization trade (per-policy-digest verdict caching) buys
little and costs a real weakening of "proved, not assumed" — and Zeros' contract
language is explicitly proof-carrying. Documented here so the maintainer decision
is informed, with the precedent recorded; per-clone **uniqueness** (generation,
broker tokens, entropy) must be minted at adoption in any design, which layer (b)
already does.

### 4.5 Queueing (why the gate was right, and what it can't do)

Little's law (L = λW) says cutting admission latency ~10× shrinks queue occupancy
~10× at the same arrival rate — capacity fixes multiply with latency fixes
(<https://doi.org/10.1287/opre.9.3.383>). A single shared FIFO caps effective
capacity near ~59 % from head-of-line blocking (Karol et al. 1987,
<https://web.mit.edu/modiano/www/6.263/Karol_1.pdf>) — the gate's two-class design
is correct; the census (§1.2) shows the classes are mislabeled, not the mechanism.
SEDA/Builders'-Library guidance: bound concurrency below saturation, shed/defer
background first, hold the interactive P95 as the SLO
(<https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/>).

---

## 5. Target architecture: ZSR-Instant

Five layers, each independently shippable, ordered by value ÷ risk. Isolation
invariants preserved by all of them are listed in §7.

### 5.0 UX contract first: a send is _always_ accepted instantly

Renderer-only. An `idle`/`warming` send must clear the composer, appear as the
active transcript turn, start its elapsed timer, and start or join session
admission in the background. Only a second message waiting behind that turn is a
queued-card row. Ordinary startup failures return unsent text to the composer;
Design-protection failure keeps the active prompt and renders the exact stopped
footer. With keystroke-arming already landed, most sessions are `warming` by
Enter. This closes the remaining gap so **no user watches a blocking spinner or
an incorrectly labelled first-message queue**, regardless of admission cost.

### 5.1 Demand diet — stop admitting what nobody asked for

1. **Fix the priority bug:** `repo-task-boundary.ts` passes `admissionPriority`
   (background for the boot PATH probe and git hooks; keep user-clicked Run/Setup
   interactive). One line plus tests.
2. **Defer the boot self-probe:** the login-shell PATH probe
   (`zeros-engine.ts:917`) does not need to race the first paint; run it after
   boot settles (or make its result durable across engine restarts keyed on shell
   - rc mtimes).
3. **Lazy boot resume:** at app start, fully admit only the **focused** chat's
   session; for other surfaced chats, hydrate transcripts from the DB (already
   admission-free, `sessions-provider.tsx:3631-3751`) and admit on
   focus/keystroke/send. Live re-adoption after renderer reload already skips
   admission (`zeros-engine.ts:4632-4697`) — this extends the same laziness to
   engine restarts.
4. **Reusable utility boundary for one-shots:** one long-lived background boundary
   per (provider, workspace) with a bounded TTL and idle teardown, serving titles,
   probes, key validation, and `listSessions` instead of prepare+prove-teardown per
   call. Probes already pin a shared provider-state scope
   (`gateway.ts:2749-2765`); this extends reuse to the boundary itself. Removes
   roughly a third of admissions in the observed logs _and_ their durable-store
   promotion churn ("preserved N concurrent provider HOME conflict(s)").
5. **Remove the dead preflight RPC** (engine handler + tests), or explicitly mark
   it diagnostic-only CLI surface.

**Expected (estimated):** boot burst drops from ~14 admissions to ~2–4; queue waits
mostly vanish at unchanged gate limit; conflict-archive churn drops.

### 5.2 Stage-DAG admission — sum → max

The dependency table (verified in §1.3 / `zsr-boundary.ts:3119-3630`) allows:

```
discover ──┬─ policy ─┬─ HOME overlay ──────┐
probe(≈0)  │          ├─ shadow git ────────┤
OrbStack   │          ├─ port pool + tools ─┼─ canary → done
reserve ───┘          └─ process-domain ────┘
```

`process-domain` (2 native execs), the port-pool/tool copies, the overlay, and
shadow git are mutually independent given the policy; today only overlay⇄shadow-git
overlap. Full fan-out makes a solo admission ≈ `discover + policy +
max(overlay, git, domain) + canary` — with today's parts, **~2.4 s → ~1.5–2.0 s
solo** (estimated), and it compounds with everything below.

### 5.3 Canary cost — same proof, fewer processes

Keep the behavioral canary per admission (§4.4 position). Make it cheap:

- **Fold the inner spawns:** the bind-mapping probe currently spawns a second Node
  inside the sandbox (`zsr-boundary.ts:601-616`); a `listen(0)` in the same canary
  process (or a descendant assertion done by the supervisor) removes one cold
  Node start. Batch the per-repo `git rev-parse` checks into one spawn where
  multiple repos exist.
- **Measure and trim the handshake:** the canary blocks on a release file polled
  against the engine's out-of-band process-domain verification (up to 10 s cap,
  `:618-625`, `:2470-2496`). Instrument it; if polling interval dominates, switch
  to an fd/pipe signal.
- **Optional (bigger lift):** a tiny compiled canary (sibling of
  `zsr-macos-process-domain`) instead of `node -e` removes the Node cold start
  entirely. Only worth it if measurement shows Node startup dominates after the
  fold.

**Expected (estimated):** canary ~0.6–1.7 s → **~150–400 ms**, and it remains the
final act before any provider byte, unchanged in meaning.

### 5.4 World build — reuse and O(changes), not recopy and O(files)

- **Diff-and-reset reuse (Bazel pattern):** after a proven teardown + promotion,
  don't delete the session HOME — reset it against the durable manifest
  (O(changes)) and return it to the pool as a ready world. The digest manifest
  already gives per-file identities; record clone-time identities the way
  `copyTree` already does (`provider-home-overlay.ts:936-947`) so baselines stay
  warm. Kills both the copy and the `rm -rf`.
- **FSEvents-kept manifests:** subscribe to the host provider dirs and the durable
  store; keep `(clock, manifest)` current between admissions so the four
  traversals become one bounded delta scan on the hot path (Watchman/Buck2
  pattern). Fall back to the full walk when the clock is cold — correctness never
  depends on the watcher.
- **Shadow git spawns:** write the sanitized config **file** directly instead of
  one `git config` spawn per entry (~17 spawns saved); import reflogs with batched
  reads; build repositories concurrently (bounded) instead of serially
  (`shadow-git-collection.ts:351-380`). Parked worlds keep a ready shadow gitdir;
  adoption refreshes refs/index against canonical (one `for-each-ref` + one batched
  `update-ref` + index byte-copy ≈ 3 spawns, tens of ms).
- **Cursor scoped history:** Cursor currently projects its _whole_ chat history
  (~35 MiB in the bench; Claude/Codex are resume-scoped,
  `provider-home-overlay.ts:2311-2331`). Extend `scopedHistory` to Cursor's
  `chats`/`acp-sessions`.
- **Resume lookup:** `scanProviderSessionFiles` full-walks the history root twice
  per resume, collect-then-filter (`:1278-1321`, bounded at 50 k entries).
  Early-exit on exact filename match and/or keep a resumeId→path index sidecar;
  record host-side seed digests (they currently re-hash, `:2300-2310`).

**Expected (measured+estimated):** warm overlay 258–744 ms (bench, 3 k files) →
**tens of ms** typical (delta ≈ 0 changes); shadow git ~45 spawns → **~10 solo /
~3 at adoption**.

### 5.5 Park worlds, not boundaries (the prewarm, reframed)

**Parked artifact = files only** (layer (a) of §3): the projected HOME content +
ready shadow gitdir + static tools, under a `parked/` namespace in engine scratch,
stamped with `{app build, workspace, provider, actor, territory generation,
providerStateEnv fingerprint, manifest clock, parked-at}`. No ports, no sockets,
no processes, no supervisor, no policy, no credential, no generation. Reaping a
parked world is `rm -rf` — it cannot trip the retirement latch, hold leases, or
race teardown proofs.

**Adoption = run the thin layer against the parked world**, inside the normal
admission (gate slot, interactive):

1. Validate stamp (build, territory generation, env fingerprint of the _scope_
   variables; PATH/toolchain/loopback changes don't invalidate the world — they
   only shape the policy built next).
2. Delta-refresh: inside the promotion lock, diff durable store + host dirs
   against the parked manifest (O(changes); FSEvents makes it usually zero);
   refresh shadow refs/index likewise.
3. Build layer (b): policy document + `policy.json`, port leases + broker tokens +
   per-session tool configs, process domain, keychain credential seed, fresh
   `generation`. (~50–100 ms total today, measured stage parts.)
4. **Run the canary** (§5.3). Proof stays per-instance, post-final-policy,
   pre-provider — the contract sentence doesn't change.
5. Register under the session's executionId as today; the pool refills in the
   background at **background** priority.

**Pool policy:** key = the stamp tuple; size 1–2 per _predicted_ provider —
predict from the agents bound to open chats and last-used provider (a degenerate
but sufficient form of Azure's histogram policy, §4.2; a real per-workspace
idle-time histogram is a later refinement). Refill after adoption and on workspace
open; evict on territory-generation change, env-scope change, app-build change,
14-day age, and a disk budget (bytes are reflinked; inodes are the budget). Miss =
today's cold path made fast by §5.2–5.4. Tag every admission `parked-hit|miss` in
the log line.

**Resume:** pool serves `newSession` only. Resume keeps its own fast path (§5.4
resume lookup + scoped projection); a later refinement can seed a parked world
post-adoption with the resume transcript delta.

**Expected (estimated):** pool-hit adoption ≈ delta (~0–150 ms) + thin layer
(~50–100 ms) + canary (~150–400 ms) ≈ **0.3–0.6 s engine-side**, started at first
keystroke → **perceived ~0 at Enter** (Cloudflare's hide-it-in-the-handshake move,
with typing as the handshake). Miss ≈ **~1–1.5 s**.

### 5.6 Scheduling — keep the gate, correct the classes, watch teardown

Gate limit 2 stays until admissions are cheap (then consider
`min(3, ⌈cores/4⌉)`); the census fixes (§5.1) are what actually empty the queue.
Add a **teardown/reap lane**: promotions inside teardown do real IO under the
promotion lock and currently log nothing — give retirement a
`SLOW_RETIREMENT_REPORT_MS` twin and run pool refills/reaps strictly background.

---

## 6. Roadmap with expected numbers

| Phase  | Contents                                                                                                                                                       | Effort    | Risk                                                                                   | Engine-side session start (est.)                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **R0** | §5.0 immediate active-turn send; §5.1 items 1–5 (priority bug, boot probe defer, lazy boot resume, utility boundary, preflight removal)                        | days      | low — UI + scheduling hints only; no policy/enforcement surface                        | solo ~2.4 s unchanged, but **queues collapse and every send is accepted <100 ms** |
| **R1** | §5.2 stage DAG; §5.3 canary fold + handshake instrumentation                                                                                                   | days      | low-medium — orchestration only; canary content unchanged                              | **~1.0–1.5 s solo**                                                               |
| **R2** | §5.4 world reuse + FSEvents manifests + shadow-git spawn diet + Cursor scoped history + resume index                                                           | ~1 wk     | medium — touches overlay/git build, guarded by existing merge/conflict tests + benches | **~0.5–0.9 s solo**                                                               |
| **R3** | §5.5 park-and-adopt worlds + predictive refill + hit/miss telemetry                                                                                            | ~1–2 wk   | medium — new lifecycle, but parked state is inert files; adoption re-proves via canary | **hit ~0.3–0.6 s (perceived ~0), miss ~1 s**                                      |
| **R4** | Provider-side: Cursor cache projection decision, OrbStack machine prewarm at workspace open (cold machine measured 65.4 s), per-workspace idle-time histograms | as needed | provider-specific                                                                      | floor = provider boot                                                             |

Sequencing rule from the prior rounds' lesson (P2b was nearly built on a contended
sample): **measure between phases on the Mac**; every number above marked estimated
must be confirmed by the `queue=`/stage log line and the new `parked-hit|miss` tag
before the next phase is sized.

---

## 7. Invariants that do not move (and how each layer respects them)

1. **Canary before any provider byte, per boundary instance.** Adoption runs the
   full behavioral canary after the final (env-fresh) policy, before any spawn.
   Parked worlds never host a process until adopted.
2. **Fresh `generation` per admission** (anti-replay, `containment/types.ts:16-21`).
   Minted in layer (b) at adoption; parked worlds contain no tokens, no entropy,
   no generation — the uniqueness lesson from Firecracker/SnapStart is designed in.
3. **Proven teardown, fail-closed latch.** Unchanged for live boundaries. Parked
   worlds are files; their removal needs no proof and cannot trip the latch.
4. **Per-session write-back surfaces.** The adopted world becomes exactly one
   session's HOME; promotion under the promotion lock is unchanged; the
   three-way-merge baselines are refreshed at adoption inside the lock, so the
   qualification ledger's "durable store reset out from under the session" class
   cannot recur.
5. **Territory is a generation.** Generation change evicts parked worlds for that
   workspace before re-admission, same as live boundaries today.
6. **Fail-closed admission.** An unqualified backend still refuses; a parked world
   never substitutes for qualification; pool misses take the qualified cold path.
7. **Boot recovery ordering.** Engine boot recovery (stale domains, mutable state,
   dead session dirs) runs before any prewarm; parked namespaces are swept as
   reclaimable files, never "recovered" as sessions.
8. **Priority is a scheduling hint only** — `admissionPriority` still never
   reaches the policy document (`containment/types.ts:26-31`).

## 8. What stays slow no matter what (say it out loud)

- **Provider boot** — Claude SDK query start, Codex app-server, Cursor host (the
  code itself calls Cursor's the slowest; its post-dispatch `computeGlobalCache`
  rebuild is measured at ~1.1 s and its cache/extensions exclusions make some of
  that per-session). This was the pre-ZSR floor too. Candidates, each a deliberate
  product decision, not a default: project Cursor's `cache`/`extensions` (weigh
  promotion churn — the exclusions exist for a reason), seed provider caches once
  per workspace instead of per session.
- **Model latency** — a 1 m 22 s Grok turn is the model, not the runtime; Cursor
  streams nothing until done, which _reads_ as stuck. A UI affordance ("model is
  generating, N s elapsed") is the honest mitigation.
- **Cold OrbStack machine** (~65 s measured) when container workflows are
  expected — prewarm the machine at workspace open (R4), don't hide it.
- **First-ever session in a workspace** — nothing to reuse; R2 makes it cheaper,
  R3's refill makes it once-per-workspace-open instead of per-send.

## 9. Edge cases the design must survive (with dispositions)

| #   | Edge case                                                                    | Disposition                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Territory generation changes while worlds are parked                         | stamp mismatch → evict + background rebuild; live sessions already re-admit via the transition lock                                                                    |
| 2   | Provider-state scope env changes (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) | part of the world key → miss; PATH/loopback/toolchain changes affect only layer (b), always fresh                                                                      |
| 3   | Another session promotes into the durable store between park and adopt       | adoption delta-diffs under the promotion lock; O(changes)                                                                                                              |
| 4   | User installs a plugin / logs in / edits `~/.claude` between park and adopt  | FSEvents-driven manifest refresh; worst case bounded delta copy at adoption                                                                                            |
| 5   | Keychain locked / credential unavailable at adoption                         | unchanged fail-closed error with advice; credentials are never parked                                                                                                  |
| 6   | Engine crash with parked worlds on disk                                      | boot sweep recognizes the `parked/` namespace as inert and reclaims by budget/age; never "recovers" them as sessions                                                   |
| 7   | App upgrade                                                                  | build stamp mismatch → discard pool (Chromium spare-process guard)                                                                                                     |
| 8   | Two engine instances / multi-window                                          | promotion lock is already cross-process; parked namespaces are per-engine-instance                                                                                     |
| 9   | Disk pressure                                                                | pool bytes are reflinked (cheap); budget + LRU eviction + existing GC sweep integration                                                                                |
| 10  | Rapid agent-picker browsing                                                  | costs nothing (keystroke-arming landed); pool refill debounced                                                                                                         |
| 11  | Send fails during background admission (unqualified backend, canary refusal) | ordinary failures restore the prompt to the composer; Design-protection failure keeps the active turn and exact stopped footer; queued follow-ups are dropped/restored |
| 12  | Resume after app restart (`providerResumeId`)                                | not pool-served; fast path via resume index + scoped projection; optional post-adoption seeding later                                                                  |
| 13  | Same-file promotion conflicts under concurrency                              | demand diet removes most concurrent same-provider admissions; utility boundary removes probe/title churn; conflict archiving semantics unchanged                       |
| 14  | Teardown-proof failure                                                       | retain and retry the exact boundary; unrelated admissions continue, while only an authority transition affected by that old policy waits for proof                     |
| 15  | Canary flake under load                                                      | gate bounds concurrency; canary remains fail-closed; R1 instrumentation distinguishes handshake wait from enforcement failure                                          |
| 16  | Design-agent / repo-task actors                                              | separate world keys per actor (policy inversion differs); repo tasks keep today's path                                                                                 |
| 17  | Many repositories (≤33)                                                      | broker port per repo reserved at adoption; parked shadow gitdirs per repo; concurrent build bounded                                                                    |
| 18  | Linux                                                                        | same design; overlayfs/reflink variants optional later; bwrap fence identical (§4.1)                                                                                   |
| 19  | Future ACP agents / native Zeros harness                                     | worlds are keyed per provider contract; a native harness with no provider HOME skips layer (a) almost entirely → near-zero adoption by construction                    |
| 20  | Clock skew / parked-world staleness                                          | manifest clocks + parked-at TTL (14 d cap, same as archive retention)                                                                                                  |

## 10. Measurement plan (what must be observed on the Mac, in order)

1. **Now (post-R0):** one boot + three sends after >30 s idle. Expect: ≤4
   admissions at boot, every send accepted instantly, `queue=` ≈ 0 on interactive
   lines, `admitted … generic` absent or background.
2. **R1:** solo `admitted` line ~1.0–1.5 s with `canary=` ~150–400 ms; new
   canary-handshake sub-timing.
3. **R2:** warm `provider-state=` tens of ms; `private-git=` residual ~0; resume
   line for a 1,500-transcript workspace unchanged vs a 10-transcript one.
4. **R3:** `parked-hit` ratio across a normal day (target >80 % for the focused
   provider), hit adoption ≤600 ms, miss ≤1.5 s; teardown lane report present;
   pool disk usage within budget.
5. **Always:** the full `check:zsr` matrix + design-containment suite green on the
   exact source; the live canary matrix unchanged — none of this work may alter a
   policy document or canary check to pass.

## 11. Direct answers to the questions asked

- **"Still it takes so much time? its queueing?"** Yes — measured: up to 30.8 s of
  queue for ~1 s of work. The queue exists because ~11 of 14 admissions were not
  user sends and one of them was mislabeled interactive. §5.1 removes the demand;
  the gate itself was the right call.
- **"It's local, not a cloud sandbox — why should it take time?"** The fence is
  milliseconds. The seconds are the per-session private world (HOME projection,
  shadow git, enforcement proof) built serially at send time. That work is real
  but does not have to be on the send path — §5.
- **"Rebooting a cloud sandbox takes time — will each session be slow?"** Nothing
  reboots locally; there is no VM. (For future cloud workspaces the same
  prebuild/pool/snapshot principles apply — Firecracker restores in hundreds of
  ms — but that is out of scope here.)
- **"Everything the same as before ZSR except isolation — possible?"** Yes:
  accepted-instantly UX (§5.0) + admission off the critical path (§5.5) returns
  session start to the provider-boot floor, which is what "before ZSR" actually
  was. Two honest deltas remain: fail-closed refusals (a safety feature, kept) and
  per-session provider caches (R4 decision).
- **"The agent spawning is the difference, right?"** Precisely: pre-ZSR spawn =
  provider process with host HOME; ZSR spawn = world + proof + provider process.
  This plan removes "world" from the send path and shrinks "proof" ~4–10×, leaving
  spawn ≈ provider process again.
- **"App reload stops the agent" and friends** — already preserved: renderer
  reload re-adopts live executions without admission
  (`zeros-engine.ts:4632-4697`); quit tears down via the engine's shutdown cap;
  boot recovery sweeps crashed state before anything else. §7 pins these as
  invariants for every layer above.

---

## 12. Implementation status (2026-08-17)

Everything below is in the working tree, typechecked, linted, and covered by the
repository's own suites (`5,988` renderer+engine tests and `441` scripts/packages
tests green, including `308` containment tests). The one check that could NOT be
run here is the live enforcement matrix: `scripts/zsr-qualification/run.mjs`'s
`live-canary` fails inside this cloud sandbox with
`bwrap: Can't mount proc on /newroot/proc` — a nested-namespace limitation, not a
regression (it fails identically with the containment changes stashed). **`pnpm
check:zsr` and the `admitted …` log measurements in §10 still have to be run on
the Mac.**

### 12.1 R0 — a send is always accepted, and the boot burst is gone

| Item                          | Where                                                                                                                                      | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §5.0 universal instant accept | `session-reload-lifecycle.ts` (`sendSessionRecoveryMode`, `queuedPromptPresentation`), `agent-chat.tsx`                                    | A send into a chat with no session no longer blocks. The first admission-waiting prompt is presented immediately as the active transcript turn and starts its elapsed timer; only real follow-ups appear in the queued card. The session starts in the background (`ensureSession` publishes `warming` before its first await). Only `failed`/`auth-required` — an explicit retry after the user fixed something — still awaits, because that is where the failure belongs. A Design-protection failure preserves that active prompt so its exact stopped footer remains visible.          |
| Dropped-queue recovery        | `sessions-provider.tsx` (`drainOrDropQueue`)                                                                                               | A queued message that can never be sent now goes **back into the composer** as this chat's draft (guarded on an empty draft so newer typing wins), and the toast says so. Parking made this reachable; losing the words would not have been acceptable.                                                                                                                                                                                                                                                                                                                                    |
| Bug 1 — priority              | `containment/types.ts`, `repo-task-boundary.ts`, `zeros-engine.ts`, `setup-hooks.ts`, `setup-runner.ts`, `run-manager.ts`                  | `RepoTaskBoundaryRequest.admissionPriority` exists and every caller states its class: the boot login-shell PATH probe and the archive hook are **background**; user-clicked Setup and Run are explicitly **interactive**.                                                                                                                                                                                                                                                                                                                                                                  |
| Boot self-probe               | `zeros-engine.ts`                                                                                                                          | The login-shell PATH probe is deferred `BOOT_LOGIN_SHELL_PATH_WARM_DELAY_MS` (20 s) behind an unref'd timer instead of admitting during engine construction.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Lazy boot resume              | `shell/conversation/lazy-boot-resume.ts`, `chat-view.tsx`, `AgentLoadSessionMessage.adoptOnly`, `zeros-engine.ts`, `sessions-provider.tsx` | Only the **focused** chat may mint an execution on mount. Every other surfaced pane sends `adoptOnly`: the engine re-adopts a live execution exactly as before (a running turn keeps streaming, cards replay) but on a miss answers `session-expired` **before any teardown, territory resolution, spawn-option derivation or admission**. The renderer then leaves the chat `idle` with its transcript and provider binding intact and admits for real on focus / keystroke / send.                                                                                                       |
| Utility boundary reuse        | `containment/utility-boundary-pool.ts`, `gateway.ts`                                                                                       | Chat titles, provider probes, key validation and `listSessions` now share ONE warm background boundary per byte-identical `BoundaryRequest` (executionId excluded) instead of each paying a provider-HOME projection + shadow Git + canary + proven teardown. Leases are serialized, a failed operation retires rather than reuses, idle expiry is 60 s, and the pool is proven torn down on gateway dispose and on every Design territory transition. Provider probes got a **stable** per-provider neutral root (emptied before each probe) so consecutive probes actually key the same. |
| Dead preflight                | `packages/protocol/src/messages.ts`                                                                                                        | `AGENT_PREFLIGHT` is documented as diagnostic-only, with the reason no session path may call it. It was already background-priority; the remaining callers are the cloud-workspace validation smoke and hand-run diagnostics.                                                                                                                                                                                                                                                                                                                                                              |

Two deliberate contract changes fell out of the pool, and the tests were updated
to encode the new ones rather than the old:

- A one-shot's boundary is **not** revoked when the call returns; it is revoked
  when the pool retires it (`gateway-identity.test.ts`).
- A one-shot whose _teardown_ cannot be proven no longer suppresses its own
  result. Nothing has failed at the moment the result is produced. The exact
  boundary remains retained for idempotent teardown retry. Under the current
  contract this does not refuse unrelated admissions; only a real authority
  transition whose proposed territory is not covered by that old immutable
  policy waits for the proof.

### 12.2 R1 — stage DAG and a measurable canary

- **§5.2 sum → max** (`zsr-boundary.ts`): tool copies, the provider HOME overlay,
  shadow Git, the macOS process domain (two native execs) and the Linux local-TCP
  broker now run as a fan-out after the policy instead of a serial line. Each
  writes into a different private root, so nothing is shared. Nothing is reordered
  across a real dependency: the container worker still starts after shadow Git's
  projections exist, the read-only host-root assertion still follows the overlay,
  recovery is still armed before any child, and the canary still runs last. A
  `settleFanOut` join guarantees no branch can publish a live resource after the
  failure path has already swept.
- **§5.3 canary** (`zsr-boundary.ts`): the admission line now carries
  `canary-setup`, `canary-attest` and `canary-release` sub-timings nested inside
  `canary=`, so the next Mac run says _which_ third of the proof is slow instead
  of leaving it to arithmetic. The process-domain handshake poll went from a 20 ms
  to a 4 ms `Atomics.wait` interval (free — it parks, it does not spin).
  **Deliberately NOT done:** folding the dynamic bind-mapping probe into the
  canary process. It currently spawns a descendant precisely because the property
  under test is that the port interposer is _inherited_; doing it in-process would
  prove only that the canary's own binds are mapped. The report offered this as a
  saving; on inspection it is a weakening, so it stays.

### 12.3 R2 — the parts that are landed

- **Shadow-Git spawn diet** (`shadow-git.ts`): the sanitized private config is
  written as ONE file instead of one `git config --add` subprocess per entry
  (~17 spawns per repository, on the admission path). The shortcut is _proved_
  rather than trusted: a single `git config --file … --null --list` read-back is
  compared against the intended entries with the same parser they came from, and
  any mismatch falls back to the original spawn-per-entry loop. Two spawns
  instead of seventeen, with the old behavior as the floor.
- **Concurrent repository build** (`shadow-git-collection.ts`): sessions are built
  4-at-a-time instead of serially (a workspace may carry up to 33). Index-ordered
  results, and failure cleanup is now index-based — the old
  `slice(entries.length)` would double-close a broker owned by a live session once
  builds can complete out of order.
- **Cursor history scoping** (`provider-home-overlay.ts`): `.cursor/chats` and
  `.cursor/acp-sessions` are excluded outright, in both directions. They are the
  `cursor-agent` CLI's conversation store; Zeros' Cursor sessions are SDK local
  agents whose conversation state lives in the private JSONL store and resumes by
  agent id, so nothing on any Zeros path reads them. They were previously only
  _unseeded_, which still left the accumulated durable copy — ~35 MiB in the
  bench, the single largest per-admission Cursor cost — to be projected and
  re-hashed into every session HOME. `.cursor/projects` stays (real SDK project
  state, including the `agent-transcripts` subagents write).
- **Resume lookup** (`provider-home-overlay.ts`): Claude's transcript scan takes a
  `stopAtName` and stops at the first exact filename hit instead of walking the
  whole accumulated history — twice per resume — to keep one file.

**Not landed from R2:** the overlay's diff-and-reset reuse and the watcher-kept
manifests (§5.4's first two bullets). Both change what the durable store means
mid-session, which is the exact class the qualification ledger already records a
data-loss bug for ("durable store reset out from under the session"), and neither
can be honestly validated without the Mac measurement gate this report itself
mandates between phases.

### 12.4 R3 — specified, not landed

Park-and-adopt worlds (§5.5) are unchanged as the design of record and are
deliberately **not** implemented here. The reason is the sequencing rule in §6:
R3's value is entirely a claim about measured latency, its risk is concentrated in
promotion semantics that can destroy a user's provider state, and both the
`parked-hit` telemetry and the `check:zsr --require-secure` matrix that would
qualify it can only be produced on the Mac. Shipping it unverified would trade a
measurable win for an unmeasurable risk in the one subsystem where that trade is
never worth taking. R0–R2 are what the perceived-latency claim rests on anyway:
every send is now accepted in <100 ms regardless of admission cost, and the boot
burst that produced the 30.8 s queue is gone by construction.

### 12.5 Cursor-specific findings and fixes

Answering "it was working fine before — check the SDK":

1. **`@cursor/sdk` 1.0.26 → 1.0.28.** Lockfile, third-party licenses and the
   packaging layout test updated; `check:cursor-asar` reports the load closure
   still fully covered. Relevant changes: `LocalAgentOptions.cwd` narrowed to
   `string` (Zeros already passes one), a new `local.dirs` multi-root option, new
   `tools`/`disallowedTools`, local per-turn `getUsage`, and a new
   `Cursor.auth.login()` credential store at `~/.cursor/sdk/auth.json`. The
   package also gained a `bun` export condition — investigated and it does **not**
   remove the Node host's reason to exist: the bundled build still lazily imports
   `@connectrpc/connect-node` with `httpVersion:"2"`, i.e. still `node:http2`.
2. **Model discovery no longer waits on the session-start path.** `newSession`
   previously awaited `Cursor.models.list()` through the freshly spawned host,
   first unbounded and then behind a 2.5 s budget. It now starts discovery,
   yields one microtask so an SDK-memory cache can be adopted, and proceeds to
   `Agent.create` without waiting for a timer or network response. Discovery
   finishes in the background; the next session and the picker (via
   `modelsDynamic`) get the catalog. Safe by construction: the catalog only
   refines validation, and `resolveValidModelId(base, undefined)` passes the
   user's pick through.
3. **Subagent transcripts were being read from the wrong home.** `PreparedBoundary`
   now exposes `providerHomePath`, and the Cursor adapter roots
   `agentTranscriptsRoot` / `findSubagentTranscriptPath` / `findSubagentByPrompt`
   at the session's projected HOME. Under ZSR the contained host writes
   `.cursor/projects/<slug>/agent-transcripts` into the projection, so defaulting
   to the engine's `homedir()` silently found nothing and every subagent card came
   up empty — a real ZSR regression, now covered by a test.
4. **`~/.cursor/sdk/auth.json` is excluded in both directions.** Zeros
   authenticates Cursor from its own settings and never calls `sdkLogin`, so
   projecting the file could only copy an account credential into Zeros' durable
   provider-state store, and promoting it back would let a contained agent write
   one into it.
5. **Multi-root parity.** `/add-dir` directories (`ZEROS_ADDITIONAL_DIRS`) now
   reach Cursor through 1.0.28's `local.dirs`, with `cwd` still primary. Before
   1.0.28 there was no way to express it, so an added directory was invisible to
   Cursor even though ZSR had already granted write authority over it.
6. **Cursor state overlay is re-preparable.** `promoteCursorStateOverlay` clears
   the generation-private JSONL root after a durable merge (and after the recovery
   hold is cleared), so a pooled utility boundary can serve a second Cursor
   one-shot instead of tripping "must start empty"; an unpromoted leftover now
   refuses with a message that says why instead of a bare `EEXIST`.
7. **Still provider-side, unchanged:** `.cursor/cache` and `.cursor/extensions`
   stay excluded, so Cursor rebuilds them per session; `computeGlobalCache` is its
   own 1 s-bounded fan-out over cursor rules / cloud rules / subagents; and a long
   Grok turn with nothing streamed until completion is the model, not the runtime.
   §8's product decisions on those are unchanged.

### 12.6 What to measure on the Mac next

In this order, against §10:

1. One boot + three sends after >30 s idle. Expect ≤2–4 admissions at boot, every
   send accepted instantly, `queue=` ≈ 0 on interactive lines, and `admitted …
generic` absent (deferred) or background.
2. A solo `admitted` line with the new `canary-attest` / `canary-release`
   sub-timings, to size §5.3's remaining options honestly.
3. `provider-state=` on a Cursor admission before/after the history exclusion, and
   `private-git=` on a multi-repository workspace before/after the concurrent
   build.
4. The full `pnpm check:zsr --require-secure` matrix plus
   `pnpm check:design-containment`, on the exact source. None of this work may
   alter a policy document or a canary check to pass.

---

## 13. Measured on the Mac (2026-08-17 evening) — and what it overturns

§12.6 asked for one solo `admitted` line. This is better: **441 admissions** read out
of the running dev channel's own log
(`~/Library/Logs/com.zeros.dev.<workspace>-c90/main.log`), which already carried the
R1 sub-timings. No new run was needed; the numbers were already on disk.

| stage               | n   | min  | p50      | p90     | max   |
| ------------------- | --- | ---- | -------- | ------- | ----- |
| **TOTAL**           | 409 | 1509 | **3439** | 10069   | 33148 |
| queue (when queued) | 36  | 1    | 4448     | 12901   | 30759 |
| probe               | 157 | 1    | 235      | 988     | 2111  |
| discover            | 441 | 11   | 80       | 171     | 2265  |
| policy              | 441 | 2    | 30       | **811** | 3180  |
| provider-state      | 441 | 1    | **969**  | 2825    | 28760 |
| private-git         | 441 | 1    | 639      | 2378    | 7912  |
| process-domain      | 367 | 1    | 4        | 7       | 778   |
| canary              | 441 | 439  | 1622     | 2242    | 3905  |
| **canary-attest**   | 84  | 449  | **1660** | 2282    | 3163  |
| canary-setup        | 36  | 1    | 1        | 2       | 2     |
| canary-release      | 84  | 11   | 13       | 28      | 53    |

By provider (p50 total): claude 7504ms, cursor 5939ms, codex 3420ms, generic 2956ms.

### 13.1 The canary is ~half of every admission, and §5.3 named the wrong causes

`canary-attest` is **1660ms p50 — 48% of a median admission**, while `canary-setup`
is 1ms and `canary-release` 13ms. So the proof's cost is entirely
spawn-to-first-attestation. §5.3 proposed trimming the handshake poll; that is
**13ms and not worth touching**. Everything else cheap was then measured directly
on the same Mac and **ruled out**:

| hypothesis                                                                                                                                       | measured                                                                                                                                                              | verdict                |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Node cold start                                                                                                                                  | `node -e ''` = 40–50ms                                                                                                                                                | not it                 |
| Electron-as-node cold start (the supervisor runtime)                                                                                             | 1.38s **first** exec of the dev binary, 40–60ms warm; packaged 60–180ms                                                                                               | not it in steady state |
| Seatbelt wrap                                                                                                                                    | `sandbox-exec -f … node -e ''` = 40–60ms                                                                                                                              | not it                 |
| SRT bootstrap inside the supervisor                                                                                                              | import 50–110ms, `initialize` 21–66ms (log monitor on), `wrapWithSandboxArgv` 6–17ms, spawn+exit 15–24ms — **98–201ms total**, against a real session's `policy.json` | not it                 |
| node-forge RSA-2048 for SRT's ephemeral MITM CA (per contained spawn, since Zeros passes `tlsTerminate` with no CA path → `generateEphemeralCA`) | 11–70ms                                                                                                                                                               | not it                 |
| Fresh per-session `zsr-macos-port-bind.dylib` copy → macOS re-validation                                                                         | fresh copy first exec = 40–50ms, same as a warm stable path                                                                                                           | not it                 |
| Sandbox **violation** cost (the canary deliberately trips many denials)                                                                          | denied ops 0.0–0.1ms/op, same as allowed                                                                                                                              | not it                 |
| The polled process-domain release handshake                                                                                                      | `canary-release` = 13ms                                                                                                                                               | not it                 |
| `orbctl version` / `status` / `list` (suspected for the bimodal `policy`)                                                                        | 10–70ms                                                                                                                                                               | not it                 |

What remains inside that window, unmeasured: three process starts in a chain
(supervisor → its sandbox bootstrap → the canary child) and the canary's own
in-sandbox probes — per-repository `git rev-parse --absolute-git-dir` and the
descendant bind probe, **both of which cross a broker back to the engine that is
itself mid-admission**. Those call for opposite fixes, so the canary now reports
its own split rather than inviting a tenth guess.

**Landed:** the canary stamps `spawnedAt` at the instant the spawn leaves the
engine and returns `timings: {boot, probes, git, bind}` in its existing result
JSON; the engine logs them as `canary-boot|probes|git|bind`, nested inside
`canary-attest`. `boot` is everything before the canary's first line ran, so
`attest − boot` is the proof work itself. The report is treated as untrusted
input: clamped to `[0, PROBE_TIMEOUT_MS]`, integers only, and only the four known
phase names are read — a canary cannot invent a stage or a verdict.

**Next Mac run answers it in one line.** If `canary-boot` dominates, the fix is the
process chain (fold the canary into a supervisor that is going to be started
anyway, rather than paying a second full bootstrap per admission). If
`canary-git`/`canary-bind` dominate, the fix is the broker round-trips, and the
same broker cost is also being paid by every `git` the agent runs.

### 13.2 `policy` was hiding a bimodal cost

30ms p50 but 811ms p90, with **151 of 441 admissions over 400ms**. The stage billed
three unrelated things: one `ShadowGitRemoteBroker.reserve()` per repository, the
container-worker reservation, and the policy document itself. Measuring the OrbStack
CLI directly did not explain it. **Landed:** the group now reports `git-broker`,
`container-reserve` and `policy` separately.

### 13.3 Re-sequenced roadmap

The order in §6 assumed the world build was the dominant cost. At p50 it is not —
the proof is. Corrected order:

1. **Canary (48% of p50).** Blocked on exactly one number, now instrumented.
2. **World build (`provider-state` 969ms p50 / 2825 p90 / 28.8s max; `private-git`
   639/2378/7912).** Unchanged as R2/R3 — still the whole of the p90 tail.
3. **`policy` p90 811ms.** Now split; likely a cheap win once named.
4. **`probe` (235ms p50 over 157 admissions).** Cached ≈0 was the assumption; it is
   not free.

### 13.4 Design fence: a container engine is never shared across the fence

**Landed** (`zsr-boundary.ts`, `containment/types.ts`): a `design-agent` actor is
refused a container worker outright, before any backend or platform validation,
with a new `design-actor-refused` reason that degrades to the existing
`container-workflows-unavailable` parity restriction and a remediation that says to
run container work from a code session. A container engine is a shared namespace by
nature — image store, volumes, container network, and whatever the machine mounts
are one surface — so it must never be a place where design and code authority can
meet, and a design actor has no code-territory build to run in the first place.

### 13.5 Per-workspace OrbStack VM: the design, and the precondition that blocks it

Today: one machine **per execution** —
`orbStackMachineName(request.executionId, mountRoots)` — created as
`orbctl create --isolated --isolate-network --memory 3072M --cpus 2 --disk 16G
--mount <root>:<root> …`, so **3 GiB + 2 vCPU committed per container-using
session**, lazily on first connection. Sharing one machine per workspace is the
single largest memory win available in the runtime (3 GiB × sessions → 3 GiB ×
workspace) and also removes the ~65s cold create for every session after the first.

**It cannot be done by changing the machine key.** Mounts are fixed at creation and
verified afterwards (`validateOrbStackMachineInfo`), and the mount set is
`minimalMountRoots([workspaceRoot, ...additionalWriteRoots, sessionRoot])`. The
session root is `<data>/sessions/<executionId>`, which contains
`boundary/<generation>/provider` — **the projected provider HOME, including seeded
credentials**. A machine shared by N sessions with today's mount list would give
every session's containers read access to every other session's provider
credentials and private Git. That is not "sessions can see each other"; it is
credential exfiltration across the fence.

The sound shape is to split the boundary root by VM visibility:

- **VM-visible, workspace-scoped:** the shadow-git roots that back
  `ShadowGitFilesystemProjection.source` (today `options.shadowRoot`, i.e. the live
  private gitdir, or the `git-worktree-entry` pointer under `toolsRoot`) and the
  container descriptors currently written into the session root. These move under
  one `<data>/…/<workspaceKey>/` root, which is what the machine mounts.
- **Never VM-visible:** provider HOME, scratch, tools, policy — they stay under the
  session root, which is no longer mounted at all. This is stricter than today even
  for a single session.

Then: key the machine on (workspace mount set + territory generation), refcount
leases so the last release deletes the machine, and move the recovery hold from
per-session to per-machine-with-owners so a crashed engine still proves the machine
gone.

**Why it is not in this change:** relocating the live shadow-git root touches policy
path construction and its physical-directory assertions, the Seatbelt read/write
roots, session teardown and its removal proof, boot recovery and GC (two roots
instead of one), the OrbStack naming/mount/refcount/recovery protocol, and the
qualification matrix — in the subsystem where the ledger already records a data-loss
bug. It also cannot be validated here: `check:zsr --require-secure`'s live canary
fails in this cloud sandbox (`bwrap: Can't mount proc on /newroot/proc`). Landing it
half-done would be the one genuinely unsafe move available.

---

## 14. The canary split, measured (2026-08-17, 21:35 run)

§13's instrumentation returned its number on the first try. Five consecutive
admissions:

```
canary-attest=1689  canary-boot=467  canary-probes=2  canary-git=1139  canary-bind=75
canary-attest=1900  canary-boot=474  canary-probes=2  canary-git=1336  canary-bind=82
canary-attest=1607  canary-boot=417  canary-probes=1  canary-git=1120  canary-bind=67
canary-attest=1699  canary-boot=512  canary-probes=1  canary-git=1111  canary-bind=69
canary-attest=672   canary-boot=501  canary-probes=3  (no repositories)  canary-bind=158
```

**`canary-git` is 1111-1336 ms — 66-70 % of the canary, and on its own the single
largest line item in the whole admission.** It is _one_ `git rev-parse
--absolute-git-dir` per repository plus one private-marker write. `canary-boot`
(engine spawn → canary code running, spanning bash → env → sandbox-exec →
Electron-as-node) is a consistent 417-512 ms. `canary-probes` — every filesystem
denial the proof depends on — is 1-3 ms.

The 1.1 s is _not_ explained by anything reproducible outside the fence. Measured
on the same Mac: the same `git rev-parse` against the same workspace is **10 ms**
unsandboxed, **10 ms** with the developer directory denied, **10-20 ms** with the
port-bind interposer inserted, **21-26 ms** wrapped by SRT's _actual generated
profile_ for a live session (368 lines, 24 KB, 53 literals, 136 subpaths — taken
straight from a real `policy.json`), against `/usr/bin/true` at 13-15 ms in the
same wrapper. `bindMounts` are documented Linux-only, so macOS is not paying a
projection cost inside SRT at all.

**So the next split is landed, not guessed:** the canary now reports `gitSpawn`
and `gitMarker` per projection, so one more line says whether the 1.1 s is the
spawn or the write into the private gitdir. Both are logged as
`canary-gitSpawn` / `canary-gitMarker` under the same clamped, four-name-plus-two
allowlist as before. The proof is unchanged — verified by running the real canary
body against a real repository and confirming `gitProjectionPrivate` still comes
back `[true]`.

### 14.1 `container-reserve` was a 680 MiB code-signature sweep — fixed

The §13.2 split named it immediately: **704-722 ms**, every admission that
requests a container worker. The cause is `attestOrbStackCli`, which runs
`codesign --verify --deep --strict` over the whole OrbStack.app bundle — measured
**570-900 ms against 680 MiB** — and the worker is constructed once per
admission. `orbctl version|status|list` had already been ruled out at 10-70 ms.

**Landed:** the whole-bundle sweep is memoized per exact on-disk identity — the
CLI executable, the bundle's `_CodeSignature/CodeResources` (the signed manifest
of every nested file's hash), and the bundle directory, keyed on
dev/ino/size/mode plus **nanosecond** mtime/ctime (millisecond fields cannot tell
two writes in one millisecond apart). The **trust decision is not cached**: the
explicit `anchor apple generic` requirement match and the identifier/team check
still run on every admission, because they are 50 ms and they are what decides
whether these bytes may create a privileged VM. A rejected identity deletes the
memo, so a failure can never be inherited. Covered by a test that asserts the
sweep runs once for an unchanged bundle, again when `CodeResources` or the CLI
changes, and again after a rejection.

Expected: **-570 to -900 ms on every container-worker admission** (i.e. every
admission on a Mac with OrbStack installed).

### 14.2 `check:zsr --require-secure` failed for an environmental reason, and said nothing

The 21:36 run reported `secure: false` with 49 checks passing and
`macos-detached-process-domain` **failing with no `detail` at all**. Run by hand,
the same fixture passes: `{"normalTeardown":true,"crashRecovery":true,"recovered":1}`,
exit 0. The run had happened with a dev app instance live, so the recovery count
was not the expected exactly-1.

That the gate could fail _silently_ is its own defect: the detail was
`error ?? stderr ?? "fixture exited N"`, and `??` only falls through on
null/undefined — a fixture that exits 0 with a report whose fields simply do not
match yields an empty stderr and therefore no detail. **Landed:** both macOS
fixtures now report exit status, which fields were observed, and stderr. Re-run
with no dev instance running.

### 14.3 Standing order of work, updated

1. `canary-git` — 1.1-1.3 s, biggest single item. One more line localizes it to
   spawn or marker.
2. `canary-boot` — 417-512 ms of process chain per admission (bash → env →
   sandbox-exec → Electron-as-node), paid again by the provider spawn that
   follows. Folding the proof into the supervisor that is about to host the
   provider is the candidate.
3. World build — `provider-state` 440-1637 ms and `private-git` 415-2109 ms in
   this same run. R2/R3, unchanged.
4. `container-reserve` — **done** (§14.1).

### 14.4 It is the git _spawn_, and it is not reproducible outside the fence

The 22:00 run: `canary-gitSpawn` equals `canary-git` on every line (1110/1110,
1122/1123, 1132/1132, 1292/1292, 1469/1469). The private-marker write is ~0 ms.
**All of it is the one `spawnSync` of git inside the fence.**

`container-reserve` in the same run: **96-149 ms**, down from 704-722 ms. §14.1
confirmed in production.

Two nested spawns from the _same_ sandboxed canary process, same run:

| nested spawn                                          | cost             |
| ----------------------------------------------------- | ---------------- |
| `process.execPath` (Electron-as-node), the bind probe | **70-114 ms**    |
| `/usr/bin/git rev-parse --absolute-git-dir`           | **1110-1469 ms** |

Everything reconstructible from outside is 10-26 ms, and two more theories died on
measurement: inserting the port-bind interposer into an Apple **platform binary**
while the fence denies `com.apple.SecurityServer` / `com.apple.securityd[.xpc]` is
**10 ms** (with or without the insert, denied or allowed), and a non-platform
binary under the same profile is 40-50 ms. So the cost belongs to the _nested_
spawn inside the live boundary, which no external harness has reproduced.

Two explanations remain, and they take opposite fixes:

1. **Per-exec cost.** Then every shell command an agent runs pays it too, and the
   fix belongs at the fence/child-environment level. This is the case worth
   hoping for — it would be the largest single latency win in the product.
2. **One-time per-boundary cost** (a cache or validation warmed by the first
   platform-binary exec). Then nothing about the proof needs to change: warm it
   during the fan-out, concurrently with the overlay build, and the canary's git
   probe is fast when it runs.

**Landed to separate them:** `ZEROS_ZSR_CANARY_DIAGNOSTICS=1` makes the canary
repeat the identical git spawn and also spawn `/usr/bin/true`, reported as
`canary-gitSpawnRepeat` and `canary-trueSpawn`. Strictly opt-in — it adds its own
second to an admission, so it is never on by default. Verified that the proof
still passes with diagnostics both on and off, and that nothing leaks into the
result when off.

Reading the next run:

- `gitSpawnRepeat` ≈ `gitSpawn` (both ~1.1 s) → **per-exec**; fix at the fence.
- `gitSpawnRepeat` ≪ `gitSpawn` → **one-time**; warm it off the proof path.
- `trueSpawn` ≈ `gitSpawn` → it is _any_ platform-binary exec, not git.
- `trueSpawn` small but both git spawns slow → it is git specifically.

---

## 15. The canary answer, and where R2/R3 actually stand

### 15.1 One-time per boundary — with a caveat about the measurement's order

The opt-in run settled it:

```
canary-gitSpawn=1484  canary-gitSpawnRepeat=242  canary-trueSpawn=1
canary-gitSpawn=1870  canary-gitSpawnRepeat=343  canary-trueSpawn=4
canary-gitSpawn=1202  canary-gitSpawnRepeat=249  canary-trueSpawn=2
```

The second identical git spawn is **5-6× faster**, so ~1.0-1.5 s of the first one
is **one-time state**. And because every _admission_ still pays it in full, that
state is **per boundary instance**, not system-wide — which is what makes it
fixable: warm it where nobody is waiting.

**Caveat that must be respected before building the fix:** the diagnostic runs
`gitSpawn` → `gitSpawnRepeat` → `trueSpawn`, so `trueSpawn=1-4 ms` only proves a
platform-binary exec is cheap _after_ git has already warmed the boundary. It does
**not** prove the first exec of a trivial binary is cheap. Those two readings imply
different fixes:

- If a trivial first exec also costs ~1.2 s → the warm-up must simply be _some_
  exec, and `/usr/bin/true` during the fan-out is enough.
- If only git's first exec is expensive → the warm-up has to be a real git
  invocation, and it must run after the shadow-git projection exists.

So the next experiment is to reorder the diagnostic (`trueSpawn` first). Naming
this rather than guessing is the same discipline that has now killed eleven
plausible explanations.

**Structural obstacle for the fix, found while scoping it:** `PreparedZsrBoundary`
is constructed _after_ the fan-out (`zsr-boundary.ts:3827`) because it takes the
fan-out's results, and `boundary.spawn` is the only way into the fence. So a
warm-up cannot currently overlap the overlay/shadow-git build — the only overlap
available today is against the canary's own ~450 ms boot. Getting the full ~1.2 s
off the critical path needs the boundary (or a narrower spawn capability) to exist
before the fan-out. That is a real refactor, not a two-line change, and it is the
next piece of work.

### 15.2 R2: what landed, and why the rest is not a "just write it" task

**Landed:** the provider-HOME copy pass now overlaps managed roots, bounded at
`MANAGED_ROOT_CONCURRENCY = 4` against the walker's own 32, for both the host-seed
projection and the durable projection. It is safe for a stated reason rather than
by inspection: `providerManagedPaths` returns **mutually disjoint** relatives
(`.agents`, `.claude`, `.claude.json`, `.codex`, `.cursor`, `.cursor-agent`,
`.config/opencode`, `.local/share/opencode`, `.local/state/opencode`) — no root is
a prefix of another, so two walks never write one destination, and the only shared
paths are ancestors created by a recursive `mkdir` that tolerates losing the race.
`mapTreeEntries` now delegates to a general `mapBounded`, so there is one
implementation of the bound. Covered by a test that projects four roots including
three that share ancestors, asserting every root arrives complete with digests
recorded, from both the host seed and the durable store.

**Not landed — and the reason is specific.** §5.4's diff-and-reset reuse cannot be
done by swapping in a fast whole-tree clone, which is what a first reading
suggests. `copyTree` is not a copy loop; it is the enforcement point for bounded
depth, bounded entry/file/byte counts, symlink-cycle detection, denied-root
containment, and the digest recording that the merge baseline is derived from
(`provider-home-overlay.ts:828-960`). A `clonefile`/`cp -Rc` of the tree would
discard all of it, and re-imposing the guards means walking the clone anyway.

That leaves the report's actual design — keep a materialized tree and refresh it by
delta — whose load-bearing invariant is not performance but **isolation**: a reused
tree must provably carry nothing the previous session wrote, or session B reads
session A's provider state. Proving that means reasoning about the three-way merge
baselines (`baselineLocal`/`baselineHost`/`baselinePersistent`), tombstones,
per-session credential suppression, per-session resume seeds, and crash recovery
holds — in the one subsystem where the qualification ledger already records a
data-loss bug. It also cannot be validated from a cloud sandbox: the live canary
fails here by construction (`bwrap: Can't mount proc`).

The safest shape found while scoping — worth recording because it is not the
report's original one — is a **pristine engine-owned template** per stamp that is
never handed to a session: sessions receive a fresh materialization _from_ the
template, so no reset is ever required and the isolation question does not arise.
The remaining cost is then the walk, not the bytes, which is exactly what the
FSEvents-kept manifests (§5.4 bullet 2) remove, and that item is fail-safe by
construction: a cold clock falls back to the full walk.

### 15.3 R3: still specified, still unbuilt

R3 adopts whatever R2's reuse mechanism turns out to be, so it cannot be built
first. Its own parts — prewarm at workspace open, predictive refill at background
priority, `parked-hit|miss` telemetry, eviction on generation/env/build change —
remain as specified in §5.5 and are comparatively small once the core exists.

### 15.4 Where the time actually goes now (22:13 run)

| stage             | observed                                   |
| ----------------- | ------------------------------------------ |
| canary-git        | 1455-2217 ms (of which gitSpawn 1202-1870) |
| private-git       | 509-2585 ms                                |
| canary-boot       | 434-479 ms                                 |
| provider-state    | 175-545 ms                                 |
| container-reserve | **86-96 ms** (was 704-722)                 |

`private-git` is now frequently the largest engine-side stage and has never been
looked inside. It is the natural next instrumentation target after the git warm-up
lands.

---

## 16. Items 1 and 3 landed; why item 2 waits on one line

### 16.1 The diagnostic is reordered (item 1)

`trueFirst` now runs as the **first child exec in the sandbox instance**, before
anything else the canary does, and the post-git control is renamed `trueLast`.
The previous ordering (git → repeat → true) could not distinguish "the first exec
here is expensive" from "git specifically is expensive", because `true` only ever
ran after git had already warmed the instance.

Reading it:

| observation                                | meaning                     | warm-up must be                                                     |
| ------------------------------------------ | --------------------------- | ------------------------------------------------------------------- |
| `trueFirst` ~1.2 s, `gitSpawn` then fast   | any exec warms the instance | `/usr/bin/true` — can run the moment the fence exists               |
| `trueFirst` ~1 ms, `gitSpawn` still ~1.2 s | git specifically            | a real `git` call, which needs the shadow projection to exist first |

Verified by executing the real canary body: `trueFirst` appears only with
diagnostics on, is absent when off, and the projection proof still returns
`[true]` either way.

### 16.2 Private-Git is split (item 3)

`ShadowGitOptions.onPhase` reports seven phases of the private-Git build —
`recover`, `config`, `refs`, `reflogs`, `index`, `state`, `validator` — threaded
through `ShadowGitCollection` and **summed across every repository** in the
workspace, then logged as `git-<phase>=…ms` nested inside `private-git`. Timing
only; it cannot change what the build does. Covered by a two-repository test that
asserts each phase is reported once per repository with a sane duration.

This is the stage that has quietly become the largest engine-side cost
(509-2585 ms) while attention was on the canary.

### 16.3 Item 2 is designed, and deliberately not built yet

The warm state is **per sandbox instance**, and every `boundary.spawn()` creates a
new supervisor, hence a new `sandbox-exec` instance. So the canary's instance is
its own, and a warm-up only helps if it runs _inside that same instance_ — which
means inside the canary process, where it is serial with the proof and overlaps
only ~3 ms of probes. The only shape that actually removes the cost from the
critical path is a **two-phase canary**: launch it early (paying boot and the
warm-up while the overlay and shadow Git are still building), have it park on a
"go" file the way it already parks on the process-domain release file, and run its
probes against the final spec once the fan-out settles.

That needs `boundary.spawn` to work before the fan-out completes, and today
`PreparedZsrBoundary` is constructed _after_ it (`zsr-boundary.ts:3827`) because it
consumes its results — the interposer dylib target comes from the tool-copy branch
and the process-domain descriptor from another. Hoisting those two cheap members
(1-4 ms each) ahead of the expensive ones is the enabling change.

**Why not now:** which warm-up command is required is exactly what §16.1 measures,
and if the answer is "a real git call", the warm-up cannot start until shadow Git
has finished — which changes what the two-phase protocol needs to overlap and
therefore how it should be built. Building the scaffolding first risks discarding
it. One admission line decides it.

### 16.4 R2 status after this round

Landed: bounded-concurrency projection across managed roots (§15.2). Still open:
the pristine-template design plus FSEvents manifests, unchanged in shape from
§15.2, still gated on the Mac qualification loop between phases.

---

## 17. Both answers arrived; the reflog import was the hidden giant

### 17.1 Item 1 result: git-specific, not first-exec

```
canary-trueFirst=2-3ms     canary-gitSpawn=1065-1284ms
canary-gitSpawnRepeat=220-280ms   canary-trueLast=1-2ms
```

A trivial first exec in a fresh sandbox instance is **free**. Only git pays, and
only on its first run. So the general exec path is warm from the start, and the
~850 ms one-time cost belongs to whatever git touches that a do-nothing binary
does not — its own binary, dylibs and Apple shim resolution, plus config paths.

This settles the warm-up's shape:

- The warm-up must be a **real git invocation**, not `/usr/bin/true`.
- It does **not** need the repository: `git --version` touches the binary, dylibs
  and shim resolution, which is where the one-time cost lives. So it can run the
  moment the fence exists, without waiting for shadow Git.
- It must run **inside the canary's own process**, because each
  `boundary.spawn()` starts a new supervisor and therefore a new `sandbox-exec`
  instance — a separate warm-up spawn would warm an instance nobody uses.

That still leaves the two-phase canary as the only way to overlap it (§16.3),
unchanged, with the enabling change being to construct `PreparedZsrBoundary`
before the expensive fan-out members.

### 17.2 Item 3 result: `git-reflogs` was up to 1693 ms — fixed

The first split of `private-git` named its dominant phase immediately:

| phase                                   | claude      | generic | codex      |
| --------------------------------------- | ----------- | ------- | ---------- |
| **git-reflogs**                         | **1693 ms** | 352 ms  | 312 ms     |
| git-config                              | 350 ms      | 292 ms  | **721 ms** |
| git-refs                                | 387 ms      | 125 ms  | 197 ms     |
| git-recover / index / state / validator | ≤18 ms      | ≤26 ms  | ≤18 ms     |

`importCanonicalReflogs` ran **one `git reflog show` per ref, awaited one at a
time**. A workspace with dozens of branches and remotes therefore paid dozens of
serial git spawns on the admission path — 1.7 s of it here.

**Landed:** those reads now overlap at `SHADOW_GIT_READ_CONCURRENCY = 4`, the same
bound the collection already uses across repositories, via a helper that settles
every worker before rethrowing so a failure cannot leave a sibling read
half-applied and unobserved. They are independent reads of canonical state.

The entry quota moved with them and is _unchanged in strength_: each ref is still
fetched under a hard per-ref cap (`MAX_REFLOG_ENTRIES + 1`) and the **total** is
still enforced against `MAX_REFLOG_ENTRIES`. What changed is only that a ref no
longer sees how much budget earlier refs consumed — which was never a security
property, just an artifact of the loop.

Covered by a new test that builds twelve branches with their own reflogs and
asserts every ref's private reflog arrives with its own entries, oldest record
first, newest record naming the canonical tip.

Expected: `git-reflogs` ~1693 ms → ~400-450 ms on a many-ref workspace, and
`private-git` is no longer dominated by one serial loop.

### 17.3 What is now the largest remaining item

1. **`canary-gitSpawn` ~1.1 s** — needs the two-phase canary (§16.3, §17.1).
2. **`git-config` 292-721 ms** — the phase still runs `init --bare`, two config
   list reads, four `git config --replace-all` writes and an unset, serially. The
   four writes are candidates for folding into the single sanitized-config file
   write that already exists, but that write has a read-back verification which
   would treat appended duplicate keys as a mismatch and fall back to
   spawn-per-entry, so it needs care rather than a quick edit.
3. **`git-refs` 125-387 ms** — one `update-ref --stdin` plus a `symbolic-ref` per
   symbolic ref; the same overlap treatment likely applies.

---

## 18. Resume latency, "always ready", and the arithmetic to <1 s

### 18.1 What the 22:59 run shows

25 admissions, **10 of them resumes** (`AGENT_LOAD_SESSION`) — a session with ~10
open chat tabs:

| stage                  | min  | median   | max  |
| ---------------------- | ---- | -------- | ---- |
| **TOTAL**              | 2236 | **3842** | 8067 |
| queue (9 of 25 queued) | 1    | 1298     | 3973 |
| canary                 | 464  | 1875     | 2852 |
| — canary-gitSpawn      | 1058 | 1114     | 1816 |
| — canary-boot          | 377  | 441      | 904  |
| private-git            | 2    | 734      | 3356 |
| — git-config           | 216  | 425      | 1158 |
| — git-refs             | 95   | 546      | 1087 |
| — git-reflogs          | 78   | 415      | 1992 |
| provider-state         | 60   | 513      | 1483 |
| container-reserve      | 72   | 85       | 211  |

**A resume pays a full admission.** `loadSession` builds the same world as
`newSession`, so opening an old chat costs the same ~3.8 s median. That is the
whole of the reported "resuming takes time".

### 18.2 Why "every chat always ready" is R3, not a flag

Eagerly admitting every open chat is exactly what §5.1 removed: with ~10 tabs and a
2-slot gate, ten builds at ~3.8 s serialize into ~30 s of queue — the 30.8 s tail
the boot burst produced — and each live boundary also holds a resident supervisor
(~45-60 MB) plus its leases. This run already shows `queue` at 1298 ms median with
demand _below_ that.

So "always ready" is affordable only when a ready world costs neither a queue slot
nor a process — which is precisely what **R3 parks: worlds, not boundaries**. A
parked world is inert files (no ports, no sockets, no supervisor), so keeping one
per open chat is cheap, and adoption is a delta-refresh rather than a build. The
feature the user is asking for _is_ R3; nothing smaller delivers it without
re-introducing the burst.

### 18.3 The honest arithmetic

From the median 3842 ms:

| change                                                                                                  | saves         | leaves   |
| ------------------------------------------------------------------------------------------------------- | ------------- | -------- |
| two-phase canary (removes `gitSpawn` ~1.1 s from the path)                                              | ~1100 ms      | ~2740 ms |
| `git-reflogs` overlap **(landed)** + `git-config` fold **(landed)** + `git-refs` symref batching (todo) | ~400 ms       | ~2340 ms |
| R2 template + FSEvents manifests (`provider-state` → ~100 ms)                                           | ~400 ms       | ~1940 ms |
| R3 park-and-adopt (resume adopts instead of building)                                                   | the remainder | **<1 s** |

**<1 s for resume, for every agent, is reachable — but only with the whole stack,
and R3 is the load-bearing piece, not an optimisation on top.** Anything less
leaves a ~2 s floor. Cutting per-admission cost also shrinks queueing
proportionally (Little's law, §4.5), which is why the order above is
cost-then-prewarm rather than the reverse.

### 18.4 One cheap resume-specific idea, recorded not built

`chat-view.tsx` already has a hover-`preparing` state that deliberately never
spawns ("a hover must never spawn or resume an agent subprocess"). Once an
admission is cheap, letting hover start the _world_ (not the provider) would make
a click land on a warm boundary without admitting all ten tabs. It is demand-driven
and one-at-a-time, so it does not reproduce the burst — but it is only worth wiring
after the costs above come down, or it just moves the 3.8 s to hover time.

### 18.5 `git-refs` batched (landed)

Ordinary refs were already one `update-ref --stdin` transaction; every symbolic
ref cost its own `symbolic-ref` spawn, and `git-refs` measured 95-1087 ms
(546 ms median). Git 2.45 added `symref-update` to the same transaction, so both
kinds now go in one spawn.

Support is discovered by **attempting** it rather than by parsing `git --version`
— a version probe is the very spawn being removed, and the transaction protocol
makes the attempt side-effect-free: an unrecognized command aborts before
`commit`, so nothing is applied. On any failure the original two-step path runs
and _its_ error surfaces, so a genuine bad ref is still reported by the code that
always reported it. Confirmed `symref-update` works on the git in play (2.50.1).

Covered by a new test that creates three remotes, each with an ordinary ref and a
symbolic HEAD, and asserts all six survive into the private view — resolved and
still symbolic — plus the existing trailing-symbolic-HEAD reflog test.

---

## 19. Qualification gate: passed, with every change of this round in it

`pnpm check:zsr --require-secure` run on the Mac, against the synced mirror:

```
secure: true | backend: srt | srt 0.0.73
checks: 49   pass: 47   not-required: 2   failed: 0   exit 0
```

Verified by direct marker check that the validated tree contained **all** of this
round's containment changes — `attestedOrbStackBundles` (codesign memo),
`design-actor-refused`, the canary's `trueFirst` diagnostics,
`mapBoundedShadowGit` (reflog overlap), `shadowConfigOverrides` (config fold),
`symref-update` (ref batching), and the overlay's `MANAGED_ROOT_CONCURRENCY`
including the three-traversal overlap.

### 19.1 Correcting §14.2

§14.2 attributed the earlier `macos-detached-process-domain` failure to a live dev
instance. That is now doubtful: this passing run **also** happened with a dev
instance live (`dev-instance.mjs` was running). So the earlier failure was
transient rather than caused by app liveness — most likely a leftover process
domain from an earlier check in the same harness run, recovered as a second one.
The detail reporting added in §14.2 is what will name it if it recurs; the "quit
the dev app first" advice was not the operative cause and should not be relied on
as a fix.

### 19.2 R2 status: the traversal work is done, the reuse work is not

Landed this round, all under one bound (`MANAGED_ROOT_CONCURRENCY = 4`, against the
walker's own 32):

- the host-seed copy pass across managed roots,
- the durable copy pass across managed roots,
- the resume-seed copies,
- and `snapshotManaged` itself — which **is** the host snapshot, the durable
  snapshot and the local baseline, i.e. three of the four traversals an admission
  performs.

Two properties are deliberately unchanged and are the reason this is safe: the
quota counters stay shared, so `MAX_FILES` / `MAX_TREE_ENTRIES` /
`MAX_TOTAL_BYTES` remain limits on the whole projection rather than per-root
allowances; and insertion order was never a property a caller could rely on,
because the walk inside a single root already fans siblings out 32-wide.

Still not landed, unchanged in shape: **diff-and-reset reuse** (the pristine
engine-owned template per stamp) and **FSEvents-kept manifests**. Their blocking
invariant remains isolation, not speed.

---

## 20. Audit for R2/R3: findings, edge cases, and the executable plan

This is the deep read of the promotion/projection path that R2 and R3 must survive.
It records three findings, the edge-case matrix, and the implementation order —
written so the remaining work can be executed in one pass rather than rediscovered.

### 20.1 Finding: the "concurrent provider HOME conflict" churn is structural

Your logs repeatedly show `[zsr] preserved 4 concurrent provider HOME conflict(s)
before session admission`. The mechanism (`provider-home-overlay.ts:2262-2278`) is a
genuine three-way conflict: for a managed relative path, the **host** entry differs
from the recorded host base AND the **durable** entry no longer matches the host. The
durable copy is then archived and the private descendants reset.

Why it fires constantly rather than rarely: both sides really are moving. Sessions
promote provider state on teardown (that moves _durable_), while the user's own
provider apps keep writing their own state (that moves _host_) — `.claude.json`
statsig/session fields, `.codex` history, telemetry caches. So ordinary use produces
a steady stream of "conflicts" over files nobody is editing in a meaningful sense.

Consequences, all visible in your logs: archive copies on the admission path,
archive growth (`pruned 6 expired provider state archive(s)`), and repeated resets of
private descendants.

**This is not a bug in the merge — the merge is doing exactly what it says.** It is a
_classification_ gap: pure cache/telemetry artifacts are being treated as
user-meaningful state. The fix is to widen the non-merged set (the same mechanism
`managedExclusions` and the Cursor `chats`/`acp-sessions` exclusion already use) to
cover known-churn artifacts. That is a product decision about provider-state
fidelity, so it is recorded here rather than made unilaterally — but it should be
made **before** R2, because any reuse scheme inherits this churn and a template that
is invalidated by statsig noise is a template that never hits.

### 20.2 Finding: `projectedDigests` is ctime-keyed, which bounds what reuse may assume

`copyTree` records `contentIdentity(await lstat(to)) → digest` for every file it
writes, and the local baseline is derived from that instead of re-hashing. The key is
a ctime-based identity. For the _current_ design that is sound: the engine writes the
file and immediately stats it, so the identity belongs to bytes it just produced.

For R2 it becomes load-bearing in a stronger way: a reused tree's baseline would be
trusted across time, and ctime granularity then decides whether a modification can
hide. Any reuse implementation must therefore key on (dev, ino, size, **nanosecond**
mtime+ctime), not the millisecond fields — the same trap that a test caught in the
OrbStack memo this session, where two writes inside one millisecond were
indistinguishable.

### 20.3 Finding: the storage sweep will reclaim a naive template

`sweepProviderHomeStorage` walks `<data>/provider-home/<provider>/<key>` and
reclaims a projection that (a) has been idle past `UNUSED_PROJECTION_RETENTION_MS`,
(b) holds no tombstones or host bases, (c) has no credential marker, and (d) whose
`content` tree holds no state. A template or parked world stored under that root
would match those conditions and be deleted mid-flight. R2/R3 must either place
parked state under a namespace the sweep does not walk, or teach the sweep about it
explicitly — and the sweep runs with crash-recovery authority, so "it happens to be
skipped" is not acceptable.

### 20.4 Edge-case matrix R2/R3 must survive

| #   | Case                                                                        | Required behaviour                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Two admissions for the same (provider, workspace) race                      | Promotion lock serializes; the loser must adopt a _post-promotion_ view, never a half-written template                                                                                |
| 2   | Session wrote a secret into its private HOME                                | A reused tree must provably contain nothing the previous session wrote — the isolation invariant, and the reason the pristine-template shape is preferred over resetting a dirty tree |
| 3   | Explicit API-key session followed by CLI-auth session                       | `suppressedCredentialRelative` is per-session; the template must not bake either choice in                                                                                            |
| 4   | Resume with `providerResumeId`                                              | Resume seeds are per-session; they are applied after materialization, never templated                                                                                                 |
| 5   | Territory generation change                                                 | Evicts templates/parked worlds for that workspace before re-admission                                                                                                                 |
| 6   | `providerStateEnv` scope change (`HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) | Part of the key ⇒ miss, not silent reuse                                                                                                                                              |
| 7   | App build change                                                            | Part of the stamp ⇒ evict                                                                                                                                                             |
| 8   | Crash mid-materialization                                                   | Recovery holds must distinguish "session tree" from "template"; a partial template is discarded, never adopted                                                                        |
| 9   | Host provider dir deleted between admissions                                | Tombstone semantics unchanged; the template refresh must see the deletion, so its manifest cannot be trusted blindly                                                                  |
| 10  | Conflict archive created during refresh                                     | Archive paths must be excluded from the template so conflicts are not templated forward                                                                                               |
| 11  | Disk pressure                                                               | Inodes are the budget (bytes are reflinked); eviction must be provable, not best-effort                                                                                               |
| 12  | Cursor's private JSONL store                                                | Already excluded in both directions; the template must preserve that exclusion or Cursor sessions regress                                                                             |

### 20.5 Implementation order (unchanged in shape, now fully specified)

1. **Classification fix (§20.1)** — widen the non-merged set for churn artifacts.
   Cheap, independently valuable, and a precondition for a template that ever hits.
2. **Pristine template (§20.4 #2)** — engine-owned per stamp
   `{app build, workspace, provider, actor, territory generation, providerStateEnv
fingerprint}`, stored **outside** the swept namespace (§20.3), never handed to a
   session; sessions materialize _from_ it and apply the per-session layer (#3, #4).
3. **FSEvents-kept manifests** — removes the remaining traversal; fail-safe by
   construction (cold clock ⇒ full walk). Do this after #2 so its correctness is
   measured against a stable projection.
4. **R3 park-and-adopt + prewarm at workspace open + `parked-hit|miss`** — adopts
   #2's mechanism; eviction per #5/#6/#7.

Test matrix required before any of #2-#4 ships: a lossless test (reused projection
byte-identical to a fresh one), a no-leak test (nothing a prior session wrote
survives), a stamp-mismatch test per #5/#6/#7, a crash-mid-materialization test
(#8), and a host-deletion test (#9) — plus `check:zsr --require-secure`, which is
now known to be runnable directly rather than user-only.

---

## 21. R2's template premise is false, and the measurement says park instead

Before building §20.5 #2 (a pristine per-stamp template that sessions materialize
_from_), the premise was measured on the Mac against the real host corpus — the
provider trees **after** every exclusion, i.e. exactly what an admission touches:
**4066 files, 1384 directories, 133 MiB**.

| Operation over that corpus                                               | Measured        |
| ------------------------------------------------------------------------ | --------------- |
| stat-walk only (warm digest manifest)                                    | **44 ms**       |
| walk + hash every byte (cold manifest)                                   | **356 ms**      |
| per-file `COPYFILE_FICLONE` walk, 32-wide — _what the engine does today_ | **337–505 ms**  |
| `/bin/cp -Rc` (whole-tree clonefile) of the same pruned tree             | **731–1221 ms** |
| `/bin/cp -R`                                                             | 1218–2124 ms    |
| `fs.cp(recursive)`                                                       | 956–1051 ms     |
| `/bin/cp -Rc` of the host trees _without_ exclusions                     | 20 884 ms       |

The template's entire value was the assumption that materializing from a prepared
tree is cheaper than rebuilding one. **It is not.** `cp -Rc` does not clone a
directory in one operation; it walks and clones per file, and it loses to the
engine's own concurrent reflink walk. So a template would replace "copy 412 ms from
the host" with "copy 337 ms from the template" — ~75 ms — while adding a stamp
lifecycle, an eviction rule, a sweep exception (§20.3) and the isolation question of
§20.4 #2. That trade is not worth taking, and the last row shows why the naive
"just clone the host" shortcut is 20 s: the exclusions are doing enormous work.

**Where `provider-state` (p50 720 ms, p90 1993 ms over 1344 admissions) actually
goes**, from the same corpus: host walk 44 (warm) / 356 (cold) + durable walk ~5
(durable content roots are only 27–86 entries) + **host-seed reflink copy ~412** +
durable copy ~0 + local baseline walk ~44. The copy is the stage.

**The copy cannot be made cheaper; it can only be moved off the critical path.**
Both baselines (`baselineHost`, `baselinePersistent`) are needed at promotion, so
their ~50 ms is irreducible. Everything else — five copy passes and the local
baseline walk — is a pure function of (host tree, durable tree, stamp), so it can be
built _before_ the admission and `rename(2)`d into place, which is O(1).

That is park-and-adopt (R3), and it makes R2's template unnecessary rather than
merely unprofitable: **a parked world is consumed exactly once.** The engine builds
it, nothing else ever reads it, one admission renames it away, and the next prewarm
builds a fresh one. §20.4 #2's "a reused tree must provably carry nothing the
previous session wrote" therefore holds _by construction_ — there is no reuse. The
per-session layer (credential bytes, resume seeds, credential suppression) is
applied after the rename, exactly as §20.4 #3/#4 require.

Expected effect on `provider-state`: a park hit removes the copy and leaves the two
irreducible baselines, the local baseline walk and the per-session layer. §22.6
measures what that actually comes to — **not** the ~60 ms this section first
estimated, because three walks remain, not one.

---

## 22. What landed: churn classification, and park-and-adopt for the provider HOME

### 22.1 The churn is 92 % one thing, and it is SQLite sidecars

§20.1 said the "concurrent provider HOME conflict" churn was a classification gap
and left the decision open. Reading the conflict archives on the Mac settles what
to classify — every archive names the relative path it copied, and every
`deletion.json` carries `sha256(relative)[0:16]`, which brute-forces back to a path:

| Conflicting path                                | Archives                                 |
| ----------------------------------------------- | ---------------------------------------- |
| `.codex/goals_1.sqlite-wal` / `-shm`            | 25 + 25                                  |
| `.codex/memories_1.sqlite-wal` / `-shm`         | 15 + 15                                  |
| tombstone conflicts (4 distinct hashes)         | 22 — **all four are the sidecars above** |
| `.cursor/skills-cursor/.sync-manifest.json`     | 5                                        |
| `.codex/goals_1.sqlite`                         | 2                                        |
| `.claude/.last-cleanup`, `.claude/.claude.json` | 1 each                                   |

**102 of 111 archived conflicts (92 %) are SQLite `-wal`/`-shm` sidecars**, including
100 % of the tombstone conflicts. The cycle is structural: a session's provider
opens the database, SQLite creates the sidecars, and on a clean close **deletes
them**, so promotion records a tombstone for a path the host still holds; the next
admission finds host ≠ recorded base with a durable tombstone, which is a conflict,
an archive copy and a reset of private descendants — on every admission, forever.

Excluding them is not a fidelity trade. A `-wal` is state of an _open_ database and
a `-shm` is a shared-memory index SQLite rebuilds; copying either beside a live
database is what SQLite's own guidance forbids, so projecting them is the _unsafe_
option and the database alone is always valid at its last checkpoint.

Enumerated paths cannot fix it — the list already carried `logs.sqlite*`,
`logs_2.sqlite*` and `state_5.sqlite*`, and Codex has since added `goals_1`,
`memories_1` and `queue_1`. So `ManagedExclusions` grew a second dimension: `paths`
(prefixes from the managed root, as before) and `names` (basenames at any depth).
`CHURN_ARTIFACT_NAMES` is anchored to a database extension so an ordinary file that
merely ends in `-journal` keeps its normal three-way merge. `.claude/.last-cleanup`
and `.claude/mcp-needs-auth-cache.json` were added as ordinary path exclusions.

**Left as an open product decision, deliberately:** `.claude.json` and
`.claude/.claude.json` mix real config (MCP servers, project trust) with
high-frequency churn (statsig, session counters, tips history) in one document. It
cannot be excluded without losing config and cannot be merged bytewise without
conflicting. A field-level merge is the only lossless answer and it couples to the
provider's schema, so it is recorded rather than guessed. Its cost is small: one
small file, and the directory relaxation already stops it resetting a subtree.

### 22.2 Identity is nanosecond-keyed

`contentIdentity` now keys on `(dev, ino, size, mtimeNs, ctimeNs, mode)` behind a
`v2:` prefix, via `bigint` stats. The prefix makes every millisecond-keyed entry
left in a persisted manifest provably non-matching rather than relying on the two
magnitudes never colliding. This is what lets a parked world's recorded digests be
trusted across time (§20.2).

### 22.3 Park-and-adopt

`prepareProviderHomeOverlay` was split into a **world build** — a pure function of
(host tree, durable tree, projection rules) — and a **per-session layer** (resume
seeds, credential suppression). The world is stamped with everything its content
depends on: this module's own on-disk identity (so a rebuild evicts, §20.4 #7), the
workspace key, the resolved managed sources (so a `providerStateEnv` scope change
misses, #6), the host and durable snapshots, the compatibility dotfiles, the
tombstones, the denied roots, and whether the credential is suppressed (#3).

- **`prewarmProviderHomeOverlay`** builds a world by calling `prepare` itself into
  `<data>/provider-home-parked/<provider>/<key>/building-<uuid>/world`, then
  publishes it by rename. There is no second projection implementation to drift.
- **Adoption** claims `current` with one `rename` — so a world is **consumed exactly
  once**, before a byte of it is read — checks the stamp, and renames the tree onto
  `policy.paths.home`. A test asserts the adopted HOME has the **same inode** as the
  parked world: proof that no directory entry was walked again.
- Because a world is consumed once, §20.4 #2 holds by construction: there is no
  reuse, so no session can inherit what another wrote. The no-leak test covers it.
- Parked state lives **outside** `provider-home/` (§20.3) and the sweep is taught
  about it explicitly: `building-`/`claimed-`/`stale-` debris past an hour, a
  `current` nobody adopted past the projection retention, and anything unrecognized.
- Every failure path falls back to a full build. `ZEROS_ZSR_DISABLE_PARKED_PROVIDER_HOME`
  turns the whole mechanism off.
- Triggers: 5 s after an admission, 5 s after a teardown promotion (the strongest
  signal — promotion moves the durable side of the stamp), and a **bounded,
  recency-ordered, sequential refill of 4 keys at boot** from `warm-inputs.json`,
  which records the exact inputs a real admission used. Bounded and sequential
  because §5.1's lesson was that readying everything at once rebuilds the burst.
- Every admission logs `parked=hit|miss`, and retirement finally has an
  admission-style report of its own (`SLOW_RETIREMENT_REPORT_MS`, stages
  `revoke`/`processes`/`domain`/`git-promote`/`provider-promote`/`reclaim`), so a
  slow teardown stops being visible only as the _next_ admission waiting on a lock.

**Unlike §5.5, resume is served too.** Resume seeds are a post-adoption layer, so a
`loadSession` adopts exactly like a `newSession` — which matters, because §18 says
resume is the actual complaint.

### 22.4 The qualification harness was hiding an engine bug as a fence failure

The gate failed after the retirement report was added: `macos-detached-process-domain`
**and** `macos-dynamic-dev-ports`, both `status=0; observed: fixture produced no
parseable report`. Cause: the fixtures build a real boundary and parsed their whole
stdout as one JSON document, so any engine line on stdout broke them — and the new
report was on stdout. **This also corrects the record twice:** the same failure
earlier in the session was attributed first to a live dev app and then to
transience. Both were wrong; it was the `[zsr] admitted …` line on a slow admission.

Fixed on both sides: the retirement report goes to stderr like every other
diagnostic in that function, and `fixtureReport()` takes the last balanced JSON
object on stdout. No check is loosened — the checks are the parsed fields.

### 22.5 What is still not built, and why

- **Parked shadow gitdir.** §5.5 parks it too, and `private-git` is 639 ms p50. It is
  the subsystem whose ledger already records a data-loss bug, and its adoption needs
  a ref/index delta refresh against canonical rather than an exact-match stamp.
- **FSEvents manifests.** Now worth less than §20.5 assumed: the two baselines an
  admission cannot avoid cost ~50 ms warm, and the copy — the part FSEvents was
  meant to help with — is what parking already removes.
- **Two-phase canary (~1.1 s).** Untouched, and now the largest single line item.

### 22.6 Measured on macOS, against the real host trees

Park-and-adopt driven directly on the Mac (temporary `ZEROS_DATA_DIR`, real
`$HOME`, so the actual `~/.codex` / `~/.claude` trees are the input):

| provider | cold (empty manifest) | warm miss | **park hit** | rename, not copy | baseline identical to a fresh build |
| -------- | --------------------- | --------- | ------------ | ---------------- | ----------------------------------- |
| codex    | 698 ms                | 359 ms    | **228 ms**   | yes (same inode) | yes — 3528 entries                  |
| claude   | 261 ms                | 194 ms    | **121 ms**   | yes (same inode) | yes — 1799 entries                  |

A hit is **~37 % faster than a warm miss** on both providers, and the adopted HOME
carries the _same inode_ as the parked world, so no directory entry of it was walked
again. `sameBaselineAsFresh` is the lossless property from §20.5 measured on real
provider state rather than a fixture.

**Why not more.** A hit still performs three walks: the host snapshot and the
durable snapshot are the merge's own baselines and cannot be skipped, and the local
baseline walk re-derives `baselineLocal` from the tree that actually landed. Only
the copy is gone. Applied to production's `provider-state` p50 of 720 ms, ~37 % is
**~450 ms**, and the earlier "~60 ms" in §21 was wrong because it counted one walk
where there are three.

**The identified next step, with its own justification measured.** The parked world
could carry `baselineLocal` outright instead of re-walking — `sameBaselineAsFresh`
above is exactly the evidence that it would be correct for the world part. What
stops it today is the per-session layer: a resume seed changes the digest of every
ancestor directory, and patching those analytically trades a property that is
computed from the tree for one that is asserted about it. That is the trade to make
next, deliberately, not as a side effect.

Note the cursor row is absent for a harness reason, not a code one: the measurement
passes an explicit `credentialSeedReader` to avoid touching the keychain, and Cursor
has no keychain projection to accept one.

---

## 23. The 00:33 log: why parking never hit, and where the last ~950 ms lives

### 23.1 `parked=miss` on every admission — the stamp could never match

The 2026-08-18 00:33 log reported `[zsr] prewarmed 4 provider world(s)` and then
`parked=miss` on **every** one of 17 admissions. Not a tuning problem — an
impossibility. `prepareProviderHomeOverlay` receives
`deniedSourceRoots: policy.document.filesystem.denyRead`, and `denyRead` contains

- `paths.policy` and `paths.commands`, under `sessions/<executionId>/boundary/<generation>/`
- `paths.networkRuntime`, under `/private/tmp/zeros-zn-<generation>/`

all three per session **and** per generation. The stamp hashed them, so it changed on
every admission and nothing was ever reusable.

Fixed by splitting enforcement from identity. `generationScopedDeniedRoots` is a new,
explicit parameter: enforced exactly like every other denied root, excluded from the
stamp. Sound because a denied root can only make the projection _throw_, never change
a byte of it, and these directories **did not exist when the world was built** — a
world built at T cannot contain bytes from a directory created after T. The remaining
denied roots are reduced to a minimal covering set, which leaves the predicate
`inside(target, denied) || inside(denied, target)` exactly as strict, because two
ancestors of one path are always ordered. Over-listing a root as generation-scoped
can only cost a miss, never allow a bad hit.

Two tests: one adopts across differing generation roots (it fails with
`expected 'miss' to be 'hit'` without the fix — the production symptom), one proves a
_stable_ denied-root difference still misses.

### 23.2 `/usr/bin/git` is not git — it is Apple's 78-way multiplexer

`executableOnPath("git")` returns `/usr/bin/git`, which on macOS is a 118 KiB stub
**hard-linked under 78 tool names** that resolves the active developer directory and
execs the real binary. Measured, same command, same repository:

|                                   | shim `/usr/bin/git` | real binary      |
| --------------------------------- | ------------------- | ---------------- |
| bare, warm                        | 8.6–9.4 ms/spawn    | **2.8 ms/spawn** |
| nested inside a live ZSR boundary | 176–189 ms          | **5–6 ms**       |

`discoverCanonicalGitRepository` now resolves past it — by attempt, ignoring
`DEVELOPER_DIR`, requiring a physical executable that reports a git version, and
falling back to whatever was on `PATH` otherwise. Measured over four full boundary
lifecycles, before → after:

| stage               | before                    | after                         |
| ------------------- | ------------------------- | ----------------------------- |
| `git-config`        | 270 / 233 / 231 / 229 ms  | **70 / 69 / 73 / 69**         |
| `git-refs`          | 69 / 54 / 50 / 51         | **40 / 24 / 24 / 25**         |
| `git-reflogs`       | 20 / 20 / 19 / 20         | **9 / 8 / 7 / 9**             |
| `private-git` total | 384 / 325 / 318 / 318     | **138 / 113 / 132 / 116**     |
| admission total     | 2285 / 2066 / 2105 / 2036 | **1794 / 1601 / 1719 / 1662** |

**This is why §17/§18's git work looked ineffective.** The reflog overlap, the config
fold and the `symref-update` batching all landed and all worked; the phases stayed
large because they are _spawn-count_ dominated and every spawn paid the multiplexer.
The same change is worth ~171 ms on every in-fence git call a contained agent makes.

### 23.3 The canary's remaining ~950 ms, now precisely located

`canary-gitSpawn` is 869–1117 ms in every boundary measured. Four more explanations
died:

1. **Not the shim.** Resolving past it moved it only 1074 → 961 ms.
2. **Not "the first exec in a sandbox instance".** `/usr/bin/true` first is 2–3 ms.
3. **Not the git binary being cold.** A genuinely cold in-fence `git --version` over a
   _non-repository_ workspace is **32 ms** (6 ms with config discovery disabled).
4. **Not warmable from outside the fence.** An engine-side `rev-parse` on the very
   same projection takes **3 ms** and changes the canary by nothing
   (950/954/1117/968 → 957/909/972/955).

What is left is exact: **the first in-fence `git rev-parse --absolute-git-dir` against
a shadow-git projection costs ~950 ms; a later one in another instance of the same
boundary costs 60–180 ms.** So the cost is per boundary, in-fence only, and specific
to git resolving the projected repository — not to git, not to exec, not to the shim.

**The only fix is therefore to pay it before the canary needs it, inside the fence.**
A warm-up cannot help unless it _completes_ first, so it must start ≥950 ms earlier —
i.e. during the fan-out, which is the two-phase canary of §15/§20. Two things are now
settled that were not before: the warm-up does **not** have to be in the canary's own
sandbox instance (a later instance of the same boundary already gets the warm price),
and the go signal needs no authority beyond being unforgeable, so it belongs in
`policy.paths.tools` — already child-read-only via `denyWrite`, and already the root
the canary reads its process-domain marker from. The spec-forgery hazard §20 raised
does not arise, because the canary keeps receiving its full spec by argv and waits
only on a boolean.

### 23.4 Honest arithmetic, and what is not fixed

From the 00:33 log's ~6 s median (queue included):

| change                   | effect                                                            |
| ------------------------ | ----------------------------------------------------------------- |
| park stamp fixed (§23.1) | `provider-state` 720 → ~450 ms p50                                |
| git multiplexer (§23.2)  | `private-git` −65 %, canary −110 ms, every agent git call −171 ms |
| two-phase canary (§23.3) | **−1.2 s, not built**                                             |

**Below 1 s is not reachable without §23.3.** The canary is ~1.3 s of every admission
and nothing else in the stage list is close.

**Existing chat tabs are not all ready at app start.** The log shows six
`AGENT_LOAD_SESSION` dispatches in a burst, each needing a full admission, with a
2-slot gate producing `queued=` 936 / 1490 / 1863 / 2215 / 5295 / 6043 ms — **half the
worst case's 12.1 s is queueing, not work.** Provider-HOME worlds are now genuinely
adopted, but a resume still builds shadow Git and runs the canary. Readying N tabs
costs N × admission ÷ slots, so this is arithmetic, not tuning: it needs §23.3 first.

**OrbStack is still per session, not per workspace.** `container-reserve` is only
~120 ms so this is not a latency item; it is 3 GiB + 2 vCPU per container-using
session. The blocker is unchanged and structural: machine mounts are fixed at
creation and include `sessionRoot`, which holds `boundary/<gen>/provider` — the
projected provider HOME with seeded credentials. Sharing one machine per workspace
with today's mount set would let every session's containers read every other
session's credentials. The VM-visible shadow-git roots have to move under a
`<workspaceKey>` root, and session roots stop being mounted at all, before the key
can change.

---

## 24. The ~950 ms is Zeros' own git dispatcher, not macOS

Six experiments in one session, each killing a hypothesis, ending in the source.

### 24.1 The measurements, in order

All inside live macOS boundaries, via the canary's opt-in diagnostics and a tsx
fixture that drives `ZsrExecutionBoundary` directly.

| observation                                                               | result                       | kills                            |
| ------------------------------------------------------------------------- | ---------------------------- | -------------------------------- |
| git's own `GIT_TRACE_PERFORMANCE` on the slow call                        | **0.215 ms**                 | git's work                       |
| `/usr/bin/true`, first exec in the canary's instance                      | **2 ms**                     | "first exec is expensive"        |
| `git --version`, **no repository**, first git exec in the canary          | **876–1018 ms**              | the repository / the projection  |
| the real `rev-parse` probe, straight after it                             | **105–113 ms**               | —                                |
| the same with `DYLD_INSERT_LIBRARIES` removed from the _child_            | **880–1081 ms**              | the interposer _in the child_    |
| engine-side `rev-parse` on the same projection                            | **3 ms**, canary unchanged   | warming from outside the fence   |
| `git --version` in a boundary with **no repositories**                    | **32 ms**                    | everything except the dispatcher |
| a warm-up spawning git as the _contained target_                          | 149 ms, canary unchanged     | —                                |
| a warm-up nesting git from a sandboxed child _without_ the dispatcher env | ~200 ms, canary unchanged    | —                                |
| a warm-up nesting the _runtime_                                           | 390–464 ms, canary unchanged | —                                |

The last control is decisive: **a boundary with no repositories has no
`ShadowGitCollection`, hence no dispatcher, and its cold in-fence `git --version`
is 32 ms.** Add a repository and the identical call costs ~900 ms.

### 24.2 What the chain actually is

`zsr-macos-port-bind.c` interposes `execv`/`execve`/`posix_spawn`/`posix_spawnp`
and rewrites the program path for the trusted git binary
(`zsr_git_program`, `ZEROS_ZSR_MACOS_GIT_DISPATCHER`). The rewrite happens in the
**parent**, which is why removing the dylib from the child's environment changed
nothing. The target is `<toolsRoot>/git`, written by
`ShadowGitCollection.create` as:

```sh
#!/bin/sh
exec <toolRuntime> <toolsRoot>/git-dispatcher.mjs "$@"
```

So every git invocation inside the fence is `/bin/sh` → a full Node process →
`git-dispatcher.mjs` → … and the dispatcher then runs `entry.client`, which is
`<entryToolsRoot>/git` — **another `/bin/sh` exec'ing another Node process**, the
credential-broker client (`shadow-git-remote-broker.ts` `install`). See §24.5: it is
**two** runtime starts per git call, not one.

This is not only the canary's cost. It is the cost of **every git command any
contained agent runs** — the first one in a session pays ~900 ms and each one after
pays ~110 ms, for what is otherwise a 3 ms operation.

### 24.3 Why the warm-up attempts failed, and what the fix is

Three warm-up shapes were built and measured; none moved the canary, because none
reproduced the dispatcher path, and the dispatcher only exists after shadow Git has
been built — by which point there is nothing left to overlap. Warming is the wrong
lever anyway: it would hide a per-command tax rather than remove it.

**The fix is to stop paying a runtime startup per git call.** The interposer is
already C running in the calling process and already resolves the dispatcher path;
the dispatch decision it delegates to Node — pick the entry whose `workspaceRoot`
contains the cwd, then exec the real git with that entry's env — is a lookup over a
config the engine writes at boundary build time. Doing it in the interposer, or in a
compiled helper, removes ~900 ms from the first git call of every admission and
~110 ms from every subsequent git command an agent runs, and it changes nothing
about what the canary proves: the redirect, the private gitdir and the marker write
are all still exercised end to end.

That is the single largest remaining item in an admission and it is now a bounded,
well-understood change rather than a mystery. It was **not** built here: it touches
the interposer that every contained process loads, and it deserves its own pass with
the enforcement matrix re-run.

### 24.4 What landed instead, and the diagnostics that found it

Landed and gate-verified this round: the park-stamp fix (§23.1) and the git
multiplexer resolution (§23.2). Kept: the canary diagnostics that produced the table
above — `trueFirst`, `gitVersionFirst`, `gitVersionNoInterpose`, and `git`'s own
performance trace forwarded through the canary's stderr, all behind
`ZEROS_ZSR_CANARY_DIAGNOSTICS=1`. They are the reason the next pass does not have to
rediscover any of this.

### 24.5 Correction and exact sizing: it is TWO runtime starts, and the floor is 5 ms

`zsr-macos-port-bind.c` has a documented bypass — `ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS=1`
in the child's environment (`zsr_git_bypass`) — which makes the real cost directly
measurable. Note this is **not** what removing `DYLD_INSERT_LIBRARIES` from the child
does: the rewrite happens in the parent's `posix_spawn`, so a child without the dylib
is still sent to the dispatcher. The earlier `gitVersionNoInterpose` diagnostic was
therefore measuring the redirected path too; it has been replaced by `gitBypassFirst`.

In a cold canary instance, in this order:

| first execs in the canary's own instance | measured       |
| ---------------------------------------- | -------------- |
| `/usr/bin/true`                          | 2–3 ms         |
| **`git --version`, redirect bypassed**   | **5–31 ms**    |
| `git --version`, through the redirect    | **835–947 ms** |
| the real `rev-parse` probe, warm         | 107–152 ms     |

**The redirect chain is the entire cost: 170× cold, 22× warm, over a 5 ms
operation.** And the arithmetic closes on the chain being two runtime starts:
`canary-boot` — one cold in-fence Node start — is 330–440 ms, and 2 × ~440 ms plus
two `/bin/sh` execs plus git is the ~890 ms observed.

### 24.6 What this does and does not make buildable

Removing the **dispatcher** hop is a dispatch change: the interposer (already C,
already in the calling process) can pick the entry whose `workspaceRoot` contains the
cwd and exec `entry.client` directly, falling back to today's Node dispatcher for any
invocation it does not fully understand (`--git-dir`, `--work-tree`, an ambient
`GIT_DIR`, `--`, or a malformed argument list). That is worth **~445 ms cold and
~55 ms warm per git call** — half the tax.

Removing the **client** hop is not a dispatch change and must not be smuggled into
one: `entry.client` is the credential-broker client, and it wraps every git call
precisely so that no operation can reach a remote without passing through the broker.
Executing the real git directly instead would be a fence regression for exactly the
operations the broker exists to mediate. Getting the second ~445 ms therefore means
making the broker reachable without a runtime start — plausibly by leaning on the
transport shim `git-remote-zeros-zsr` that already exists and letting local
operations run unwrapped — which is a credential-brokering redesign with its own
threat model, not a performance tweak.

So the honest sizing of §24.3's fix is **half of the tax, safely**, and the other half
behind a separate design decision. Neither is built here; both are now measured rather
than guessed, and `gitBypassFirst` gives any future attempt a 5 ms floor to aim at.

---

## 25. The compiled shadow-Git dispatcher (built)

### 25.1 Why not the interposer

§24.6 proposed doing the dispatch inside `zsr-macos-port-bind.c`. Reading it first
ruled that out: `zsr_git_program` substitutes a _program path_ and nothing else, so
choosing an entry there would also mean rewriting `envp` — allocation on a path that
`execve` reaches after `fork()` in a threaded process, where `malloc` is not
async-signal-safe. The same win is available one process later, with none of that
hazard.

`<toolsRoot>/git` is now a compiled binary (`zsr-git-dispatch.c`) instead of
`#!/bin/sh exec <toolRuntime> git-dispatcher.mjs "$@"`. It removes the `/bin/sh` exec
_and_ the dispatch runtime, and the interposer is untouched — it still rewrites Git
invocations to `<toolsRoot>/git`, which is simply no longer a script.

### 25.2 What it will and will not answer

It handles exactly one shape: a single configured repository, a resolved working
directory inside its workspace root, nothing between the caller and that root that
looks like a repository of its own, no `--git-dir` / `--work-tree`, and no ambient
`GIT_DIR` the entry did not set. `-C` is understood rather than refused — it is how
tools address a workspace, and refusing it would leave the canary's own probe on the
slow path — so the argument is consumed and the client runs in the resulting
directory, which is what the Node dispatcher did.

Everything else `execv`s `git-dispatcher.mjs` unchanged. The Node dispatcher stays on
disk and stays the reference implementation; the binary is a fast path in front of
it, never a replacement. A dispatcher that guessed would be worse than a slow one,
because selecting the wrong private repository hands a session another session's Git
view — so every uncertain case is spent rather than resolved.

It is also not a boundary. Seatbelt still denies canonical Git paths whatever it
chooses; it execs the entry's **client**, so the credential broker is still the only
route to a remote; and the admission canary independently proves Git resolves to the
expected private directory, so a mis-selection fails an admission rather than
escaping one.

### 25.3 Measured

Same fixture, four boundary lifecycles, across this session:

|                                | at §23 start | after the Git multiplexer fix (§23.2) | with the compiled dispatcher |
| ------------------------------ | ------------ | ------------------------------------- | ---------------------------- |
| admission total                | 2036–2285 ms | 1601–1794 ms                          | **1293–1363 ms**             |
| `private-git`                  | 318–384 ms   | 113–138 ms                            | 108–139 ms                   |
| `canary-gitSpawn`              | 1062–1110 ms | 835–947 ms                            | **560–621 ms**               |
| in-fence `git rev-parse`, warm | 176–189 ms   | 107–152 ms                            | **58–85 ms**                 |

Admissions now fall below `SLOW_ADMISSION_REPORT_MS`, so they stop being logged as
slow at all. The residual `canary-gitSpawn` of ~560 ms is the remaining runtime
start — the credential-broker client — which is §24.6's second half and task #11.

### 25.4 Coverage, and a pre-existing macOS failure it uncovered

The binary is built by `xcrun clang`, so it exists only where it can be built, and
the Linux suites never execute it. Both halves are now covered: the collection tests
assert what the engine installs and that the configuration is exactly the line-based
grammar the parser accepts (on every platform), and a macOS-gated suite drives the
binary itself through ten scenarios — fast path, `-C`, pathspec separator, nested
repository, explicit `--git-dir`/`--work-tree`, ambient `GIT_DIR`, outside every
workspace, two entries, and an unreadable configuration.

Running the collection suite on macOS for the first time also surfaced two failures
that predate all of this: its temporary root came from `mkdtemp` without
`realpath`, and on macOS `/var` is a symlink to `/private/var`, so every comparison
against a resolved path failed. The suite had only ever run on Linux. Fixed by
canonicalizing the root — worth knowing that this class of test was green on CI and
red on the platform that ships.

---

## 26. Task #11 audited, and why the proposed shape must not be built

### 26.1 The brokered set is Design protection, not credentials

`git-client.mjs` already contains the split this task proposed to invent:

```js
if ((linkedWorktree && operation !== "push") || !BROKERED.has(operation) ||
    args.includes("--help") || args.includes("-h")) runNative();
else /* talk to the broker */
```

with

```
BROKERED = push fetch pull checkout switch reset restore clean
           merge rebase cherry-pick revert stash rm mv
```

**Only three of those fifteen are network operations.** `checkout`, `switch`,
`reset`, `restore`, `clean`, `rm`, `mv`, `stash`, `merge`, `rebase`, `cherry-pick`
and `revert` are brokered because they can destroy or rewrite protected Design
directories — they are the Design fence's enforcement path, not the credential
path.

So the proposed rule — "local operations exec the real git directly, anything
touching a remote goes through the broker" — routes `git checkout`, `git reset
--hard`, `git clean -fdx`, `git rm` and `git stash` **around Design protection**.
That is the isolation the same instruction forbids weakening, so it is not built.

Everything outside that set — `status`, `rev-parse`, `add`, `commit`, `log`,
`diff`, `branch`, `show` — already takes `runNative()`, a plain spawn of the real
Git with `ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS=1`. The client's runtime start is
pure overhead for those, and _reproducing its existing decision_ — rather than
inventing a network-based one — is the safe version of this optimization.

### 26.2 The blocker that stops the safe version too

Reproducing that decision in the compiled dispatcher means reproducing
`linkedWorktreeEnvironment()`, which resolves `<cwd>/.git` and requires the target
to lie strictly inside `config.shadowRoot`. That configuration value is derived as

```js
shadowRoot: path.dirname(options.toolsRoot) + path.sep + "git";
```

which is the **single-session** layout. Under a `ShadowGitCollection` the session is
built with

```
shadowRoot = <collectionShadowRoot>/<id>/git
toolsRoot  = <collectionToolsRoot>/git-repositories/<id>
```

so the derived value is `<collectionToolsRoot>/git-repositories/git` — a sibling of
the per-repository tools directories, not the shadow root. Directly observed: a
collection's `git-repositories/` contains only `0-<hash>`, so that path does not
exist, `realpathSync` throws, and `linkedWorktreeEnvironment()` returns `null` for
every invocation. Every production boundary goes through `ShadowGitCollection`, so
the client's linked-worktree branch appears to be unreachable there.

That has to be resolved before anything reproduces this decision: a second
implementation would either copy a dead branch or silently disagree with the first
once it is fixed. It is recorded rather than repaired here because the linked-worktree
tests currently pass, which means either the behaviour is correct by another route or
those tests do not cover the branch — and telling those apart is its own piece of
work in the subsystem whose ledger already records a data-loss bug.

**Also corrected:** an earlier reading here concluded the per-entry client is
installed only when a remote broker is passed to the collection. That is wrong —
`git`, `git-client.mjs`, `git-remote-zeros-zsr` and `git-transport-client.mjs` all
appear under a collection built with no `remoteBrokers` at all, so the session starts
its own.

### 26.3 What remains, sized

| item                                                     | worth                     | state                                |
| -------------------------------------------------------- | ------------------------- | ------------------------------------ |
| dispatcher hop                                           | ~300 ms cold, ~50 ms warm | **landed** (§25)                     |
| client hop, via the client's _own_ native/brokered split | ~560 ms cold              | **blocked on §26.2**                 |
| client hop, via a network-based split                    | —                         | **refused**: breaks the Design fence |
| `canary-boot`                                            | ~345 ms                   | untouched                            |

---

## 27. §26.2 settled: the derivation was a bug, and it is fixed

### 27.1 It was genuinely dead, and the suite could not have seen it

`git-client.mjs` drops the process-wide `GIT_DIR` / `GIT_INDEX_FILE` overrides when
the caller stands inside a linked worktree of the private repository, deciding that
by resolving `<cwd>/.git` and requiring the target to lie inside
`config.shadowRoot`. That value was derived as `dirname(toolsRoot)/git`.

Under a `ShadowGitCollection` — which is every production boundary — the session is
built with `shadowRoot = <collShadow>/<id>/git` and
`toolsRoot = <collTools>/git-repositories/<id>`, so the derivation named
`<collTools>/git-repositories/git`. That directory does not exist (the parent holds
only `<id>` entries), `realpathSync` threw, and the branch returned `null` for every
invocation.

**Why no test caught it.** `ShadowGitCollection.childEnvironment` spreads the
session's Git environment **only on darwin**. On Linux a contained child carries no
`GIT_DIR` at all, Git discovers the repository from the filesystem, and dropping the
overrides is unnecessary — so the branch is a no-op there whether or not it fires.
The entire failure mode lived on the platform the suite does not run on, and its
consequence is the one the ledger already warns about: a commit made inside a linked
worktree written against the **primary** checkout's index.

### 27.2 The fix, and the test that would have caught it

`ShadowGitRemoteBrokerOptions` now takes `shadowRoot` explicitly and
`ShadowGitSession` passes its own. Nothing is derived.

The test asserts the derivation _and_ the reason it matters: it reads the embedded
config out of each generated `git-client.mjs`, requires it to equal that repository's
shadow root, then creates a linked worktree through the collection's own environment
and requires the worktree's resolved gitdir to fall strictly inside it —
`worktrees/linked`, measured. Restoring the old derivation fails it. It is
platform-independent, so the macOS-only consequence is now covered by the Linux run.

### 27.3 What this unblocks, and what it does not

The compiled dispatcher may now reproduce `git-client.mjs`'s native/brokered split
without copying a dead branch, which is the ~560 ms of §26.3. That is still to build,
and §26.1 still stands: the split it reproduces must be the client's own, never one
derived from network reachability.

**Verified:** 560 containment + agent, 753 git, 430 design-containment on Linux; 78
of the shadow-Git suites on macOS, where this bug lived; `check:zsr --require-secure`
`secure: true`, 49 checks, 0 failed.

---

## 28. The client's own split, reproduced in the dispatcher (built)

### 28.1 What was reproduced, and what was refused

`zsr-git-dispatch.c` now makes the decision `git-client.mjs` makes: for an
operation outside the brokered set it execs the admitted Git directly with the
entry's environment and `ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS=1` — which is exactly
`runNative()` — and for anything in the set it execs the client as before. The
brokered list is copied verbatim and commented as a fence, because twelve of its
fifteen entries protect Design directories rather than credentials (§26.1). Nothing
is classified by network reachability.

Three refusals keep it honest:

- **A regular `<cwd>/.git`** — the shape the client inspects to decide whether the
  caller is inside a linked worktree — sends the command to the client rather than
  reproducing that decision. Measured, this costs almost nothing: a shadow
  projection leaves the primary workspace's `.git` a **directory** on both platforms
  and redirects Git through `GIT_DIR` in the child environment, and a
  session-created worktree lands outside the workspace root, so the fast path's
  existing preconditions already exclude every linked worktree. The guard makes that
  an enforced condition instead of an argued one.
- **`--help`/`-h` anywhere** follows the client, which forces native for it.
- **`git worktree`** keeps its native route but drops `GIT_INDEX_FILE`, because a
  worktree must build its own index — the same carve-out, and the same reason, the
  client documents.

### 28.2 Measured

`canary-gitSpawn`, four boundary lifecycles each:

|                                        |                |
| -------------------------------------- | -------------- |
| before the compiled dispatcher         | 835–947 ms     |
| compiled dispatcher (§25)              | 560–621 ms     |
| **with the client's split reproduced** | **187–246 ms** |

Against the 5–31 ms floor a bypassed Git measures, what remains is one exec of the
real Git plus the dispatcher itself. The `canary-boot` and `private-git` figures in
the same runs are inflated and should be ignored: the Mac was at load average 23
with `diagnosticd`, `WindowServer` and live dev instances competing. The
`gitSpawn` delta was measured under that same load, which is why it is the number
quoted.

### 28.3 Coverage

The macOS-gated suite grew to 21 cases: the native route with its environment
asserted end to end (entry `GIT_DIR`, dropped `GIT_CONFIG*`, `PATH` prefixed, bypass
set), all fifteen brokered operations individually, `--help` on a brokered
operation, the `worktree` index carve-out, the linked-worktree refusal, plus the
existing entry-selection and delegation cases. Two pre-existing cases changed from
`CLIENT` to `NATIVE` because `status` and `log` are unbrokered — the behaviour they
now assert is the point of the change.
