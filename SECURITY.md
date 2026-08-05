# Security Policy

Zeros is a desktop application that runs on a developer's own machine with
substantial local authority: it spawns child processes, invokes `git`, stores
credentials in the macOS Keychain, and executes third-party AI agent CLIs
against the user's source code. Auto-update means a defect ships to installed
users without their intervention. Security reports are taken seriously, and they
are the one form of inbound contribution this project actively wants — see
[CONTRIBUTING.md](CONTRIBUTING.md) for why everything else is closed.

## Supported versions

Zeros releases on three channels — Alpha, Beta, and Production — and every
channel auto-updates.

| Channel | Supported |
| --- | --- |
| Production (stable) | Yes — the latest release only |
| Beta | No — pre-release validation; fixes land in the next stable |
| Alpha | No — unstable by design |
| Builds you compiled yourself, or any fork | No |

Fixes are shipped forward on the current Production release. There are no
backports to older versions: the updater's job is to move users onto the fix.
If you are not on the latest stable build, update before reporting — the issue
may already be closed.

## Reporting a vulnerability

**Use GitHub Private Vulnerability Reporting:**

> **https://github.com/withso/zeros/security/advisories/new**

That channel is private between you and the maintainer, supports attachments,
and produces a CVE and a published advisory at the end if one is warranted.

Please do **not** open a public issue, post to social media, or use the in-app
feedback form for a vulnerability — the feedback form is a low-sensitivity
support pipe and is not an appropriate place for exploit detail.

A useful report includes:

- The affected version and channel (Zeros → About, or the version in the
  updater panel).
- macOS version and chip (Apple silicon / Intel).
- What an attacker gains, and what access they need to start — local user,
  a malicious repository the victim opens, a hostile page loaded in the
  Browser tab, a crafted `zeros://` deep link, a man-in-the-middle on the
  update or auth flow.
- Reproduction steps, or a proof of concept. A short screen recording is fine.

## What is in scope

- **The desktop app** — Electron main process, preload bridge, and renderer.
  Renderer HTML/CSS injection is explicitly in scope: in an Electron app an XSS
  is a step toward code execution on the user's machine, not a cosmetic bug.
- **The local engine sidecar** — its HTTP/WebSocket surface, the agent adapter
  layer, the git module, and anything reachable from another local process.
- **The updater** — signature or notarization bypass, downgrade attacks,
  channel confusion, tampering with the update feed or its artifacts.
- **The authentication handoff** — the `zeros://` deep-link callback, token
  exchange, session storage, and Keychain handling.
- **Secret handling** — API keys or tokens leaking into logs, crash reports,
  telemetry, feedback payloads, or on-disk state.
- The web surfaces and control plane that back the above.

## What is out of scope

- **Third-party agent runtimes and SDKs** — some are bundled with the desktop
  release and others may be resolved from the user's machine. Report defects
  inside those components to their vendors. Bugs in how *Zeros* packages,
  invokes, authenticates, or isolates them are in scope.
- **The user's own API keys and agent credentials**, including keys they paste
  into an agent or commit to their own repository.
- Self-inflicted configuration: permission modes deliberately loosened,
  `--dangerously-*` style flags, or an agent doing exactly what the user
  authorized it to do.
- Attacks that require an already-compromised machine, physical access, or
  root.
- Findings from automated scanners with no demonstrated impact, missing
  hardening headers on static marketing pages, and dependency CVEs with no
  reachable path in this codebase (say so if you believe the path is reachable
  — that is a real report).
- Social engineering of the maintainer or of users.

## What happens next

Zeros is maintained by one person, so these are honest targets rather than
contractual SLAs — all best effort:

1. **Acknowledgement** — typically within 5 business days. If you hear nothing
   after 10, please ping the same advisory thread; it means it was missed, not
   ignored.
2. **Triage** — an initial severity assessment and a yes/no on reproduction,
   typically within 10 business days of acknowledgement.
3. **Fix and release** — the fix rides the normal Alpha → Beta → Production
   train, expedited for high severity. You'll be told which release contains
   it.
4. **Disclosure** — coordinated. The default window is 90 days from
   acknowledgement, and the advisory is published once the fix has reached
   Production and users have had a chance to auto-update. If a fix is going to
   take longer than that, it will be discussed with you rather than decided
   unilaterally.

## Credit

Reporters are credited by name or handle in the published advisory if they want
it, and are equally welcome to stay anonymous — just say which in your report.

There is no paid bug bounty. Please don't expect payment, and please don't let
its absence stop you from reporting.
