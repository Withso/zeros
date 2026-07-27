# Contributing

Zeros is **source-available, closed to contribution**.

The full source of the Mac app, the local engine sidecar, and the web surfaces is
published under the [MIT License](LICENSE) so you can read it, audit it, learn
from it, and fork it. What the project does **not** do is accept changes back:

- **Pull requests are closed unmerged.** This includes typo fixes, dependency
  bumps, and one-line patches. No review is performed, so please don't invest
  the time.
- **Issues are not a support channel.** See [SUPPORT.md](SUPPORT.md).
- **Security reports are the one exception.** They are welcome and read. See
  [SECURITY.md](SECURITY.md).

## Why

Zeros is a single-maintainer product with a release train: every change flows
through Alpha → Beta → Production, each build is code-signed and notarized under
one Apple identity, and users receive it automatically through the in-app
updater. Merging outside code puts a third party's work into a binary the
project signs and ships to other people's machines — that carries review,
provenance, and long-term support obligations the project cannot honestly commit
to right now. Rather than leave PRs open for months, the policy is stated up
front.

This is a window, not a door. The code is genuinely open to read; the release
train is not open to push to.

## What you can do

- **Read it.** [README.md](README.md) covers the three-process architecture.
  The interesting parts are the agent adapter layer (`src/engine/agents/`), the
  wire-event vocabulary (`src/zeros/bridge/`), and the Electron main/renderer
  split (`electron/`).
- **Fork it.** MIT permits use, modification, and redistribution — commercial
  included — provided the copyright notice and license text travel with the
  copy. Your fork is yours; you do not need permission and you do not need to
  tell anyone. Please don't ship it under the name "Zeros" or with the app
  identifier `com.zeros`, so users can tell the builds apart.
- **Report a vulnerability privately.** [SECURITY.md](SECURITY.md) explains how.
- **Tell us it's broken.** The app has a built-in **Send feedback** command
  (⌥⌘F) that attaches the app version and recent logs. It reaches the
  maintainer far more reliably than a GitHub issue does.

## If you opened a PR anyway

No hard feelings — the policy isn't obvious from a fork button. The PR will be
closed with a pointer to this file, and the branch stays in your fork where you
can keep using it. If your change fixes something real, describe the problem in
the in-app feedback form (or, for a vulnerability, through the private channel)
and it can be fixed here directly.
