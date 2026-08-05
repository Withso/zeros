# Contributing to Zeros

Zeros is open source under the [MIT License](LICENSE), but the maintainer is not
currently accepting external pull requests.

This is a capacity and release-ownership policy, not a restriction in the
license. You may inspect, modify, and redistribute a fork under the MIT terms.
Please do not invest time preparing a pull request for this repository: it will
be closed without review, including documentation and dependency-only changes.

## Why pull requests are currently closed

Zeros is maintained through an Alpha → Beta → Production release train. Desktop
builds are code-signed, notarized, and delivered through an auto-updater. The
maintainer must be able to review, support, and establish provenance for every
change included in those binaries. The project cannot yet provide that review
capacity for external patches, so stating the limit up front is more respectful
than leaving contributions pending.

This policy may change as the maintenance model grows.

## Ways to help

- Review and learn from the source.
- Build or maintain a fork under the MIT License. Use a distinct product name,
  bundle identifier, update feed, authentication tenant, and signing identity so
  users can distinguish it from official Zeros releases.
- Send reproducible product feedback through the app's **Send feedback** command
  (`⌥⌘F`).
- Report security vulnerabilities privately using
  [SECURITY.md](SECURITY.md). Security reports are actively welcomed.

GitHub Issues are not a guaranteed support channel. See
[SUPPORT.md](SUPPORT.md) for supported routes and scope.

## Maintainer workflow

Maintainer changes must follow [AGENTS.md](AGENTS.md) and [RULES.md](RULES.md),
include adjacent regression coverage, and pass the applicable commands documented
in `package.json`. Changes to a public dependency, generated source, or bundled
asset must also update [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), run
`pnpm licenses:generate`, and commit the resulting
[license bundle](THIRD-PARTY-LICENSES.txt).
