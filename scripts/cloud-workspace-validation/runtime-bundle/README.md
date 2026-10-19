# Linux runtime bundles

From a clean checkout of an exact commit, with the repository's pnpm dependencies installed:

```sh
pnpm cloud:runtime-bundle:build --out-dir .context/runtime-bundle
pnpm cloud:runtime-bundle:verify --out-dir .context/runtime-bundle --closure
```

The output directory must not exist. `--source-commit <40-hex>` additionally
requires that exact HEAD. The build exports tracked source into a disposable
directory and uses a fresh HOME and pnpm store. It does not modify the checkout.
An optional `--work-dir <new-directory>` retains build intermediates for local
debugging; they are not publication inputs. Child output is captured, and CLI
stdout uses closed, value-free diagnostics. A payload scan failure also reports
the first offending relative payload path and check name on stderr; file contents,
symlink targets and credential-shaped filenames are never printed. No provider
credentials are needed.

The byte scan rejects the actual checkout, output and build-work directory
prefixes, including the private HOME, stores and caches beneath the build-work
directory. It scans every staged file and symlink without vendor exemptions.
The ambient operator HOME is not a build root: upstream SDK executables contain
their own compiler provenance under `/home/runner`, even when built elsewhere.
Those original vendor bytes are preserved; their unrelated paths do not identify
this build's checkout or temporary directories.

Host requirements: Linux x64 with glibc, a C/C++ toolchain supporting C++20,
make, Python 3, Git, GnuPG, `dpkg-deb`, GNU tar/xz, readelf, bubblewrap and
util-linux (`setpriv`). GnuPG and `dpkg-deb` are build-host requirements; acquiring
these packages never runs in a guest that will become a base or Computer snapshot.
User/mount/network namespaces must be enabled. CI's target is Ubuntu 24.04;
Amazon Linux 2023 can build and run the offline module checks. No Docker is used.
The build downloads Node 22.23.1 from nodejs.org, verifies its official SHA-256
checksum, bootstraps pnpm 10.28.0, and uses that Node for both native rebuilds.
Installed ELF objects must be x86-64 and require no GLIBC newer than 2.39.
The receipt records GLIBCXX/CXXABI and library needs for base qualification.
It does not qualify the production VM boundary, workload custody, or the base's OS libraries.

## Cloud source and package closure

The cloud builder inventories every retained engine, Host, setup and qualification
source entry with esbuild before staging dependencies. The resulting
`worker/runtime-source-closure.json` records relative source inputs, imports and
package roots. Engine sources and standalone child helpers remain available to
the existing source-mode qualification loader; renderer source and source tests
are excluded. Local desktop builds and their dependency graph are unchanged.

Named native/CLI lookups and language servers have explicit roots in
`source-closure.ts`. Each selected package keeps its complete declared dependency,
optional and peer closure, package data, declarations, executable shims and notices,
subject to the existing platform and per-package exclusions. A missing required
edge still fails the build. Do not replace this with a blanket extension filter:
language servers and late imports use files a JavaScript bundler cannot discover.

The normal engine bundle, offline source/native/command probes, archive hashes,
base attestation and live qualification remain required. A smaller package graph
is a byte reduction, not evidence of a particular provider restore time.

## Bundled Git LFS and Design fonts

`system-assets.ts` acquires Git LFS 3.7.1 from Ubuntu resolute and eight font
packages from Ubuntu noble, using `third_party/runtime-assets/lock.json`. The
checked-in Ubuntu archive key authenticates each pinned InRelease; its SHA-256 entries
authenticate the exact Packages/Sources indexes, which authenticate package
name, version, architecture, size and SHA-256. Downloads must match before use.
There is no APT installation, maintainer-script execution, ambient keyring,
key-server lookup or insecure fallback. `extract-deb.py` validates root metadata
and uniqueness too, and rejects escaping paths, unsafe modes/owners, devices,
links used as ancestors and link-through-link targets before `dpkg-deb -x`.
Updating pins is an explicit, reviewed change. See the
[asset provenance guide](../../../third_party/runtime-assets/README.md).

The payload stages `bin/git-lfs`, `worker/gitconfig`,
`worker/design-fonts/fonts.conf`, actual font files under package-specific
subdirectories, and `worker/runtime-system-assets.json` before dependency
inventory, tree hashing and ELF inspection. Every byte is covered by the normal
runtime manifest; the LFS executable must pass the same architecture/ABI gate as
Node. Exact copyright texts, linked Go dependency notices, licenses and required
source archives/build recipes remain under `worker/third_party/runtime-assets/`
and package copyrights under `lib/runtime-system-assets/`. Font sources add about
57 MB compressed; they are redistributed for license compliance, not executed.

The v4 engine view and its agent, workload, MCP and terminal/SSH environments use
the selected physical runtime's `bin` on PATH and its `worker/gitconfig` as
`GIT_CONFIG_SYSTEM`. Shipped LFS filters derive an absolute executable from that
selected config, so login profiles resetting PATH cannot select stock LFS.
The config contains no build-host path or recursive content-derived runtime ID.
For plain `git lfs` and generated LFS hooks, the root launcher publishes
`/opt/zeros-infra/.git-exec/<runtimeId>` and sets `GIT_EXEC_PATH` to that exact pin.
This read-only projection links every native Git helper/library to the approved
provider installation; only `git-lfs` points to the runtime. Native Git remains
an explicitly trusted Boat tool. The launcher validates ownership, path ancestry
and every cached link, reconstructs missing links after an interrupted creation
or restore, and refuses changed or foreign entries. It creates each final
directory in place, without a directory rename. This auxiliary sibling stays
outside the archive's hashed runtime tree. After validating ownership, type and
ancestry, the launcher explicitly sets and rechecks the parent at 0755, including
first creation or interrupted reuse under the host's unchanged private 0077
umask. New views mount its parent read-only;
older resident views already mount `/opt/zeros-infra` read-only, so they can admit
new pins while preserving existing terminals and their pins. Stock system
directories and user profiles stay unchanged.

Design capture and the same child environments use
`FONTCONFIG_FILE=<runtime>/worker/design-fonts/fonts.conf` and
`FONTCONFIG_PATH=<runtime>/worker/design-fonts`. The config resolves bundled
fonts relative to itself and keeps them authoritative for their families, even
when stock `/usr/share/fonts` contains newer versions. It marks and rejects only
stock faces of the pinned, fontconfig-visible families, including their styles
and localized aliases; stock-only families such as Liberation remain available.
Directory globs cannot override font-pattern rejection in fontconfig, so the
rule qualifies stock paths during scanning. A rule-specific directory salt
separates these cached patterns from the host's unfiltered catalog and changes
with the family list. Update that list when changing font pins. Caches stay
under the user's XDG cache; the archive embeds no runtime ID or build path.
Recipe environment values cannot replace these selections. Codex's native shell allowlist carries exactly these four
non-secret selectors from the credential-free executor. Cloud stdio MCP entries
receive them explicitly because native transports filter inherited variables.
SSH selects them at both production entries and still rejects client environment
injection. No global `/etc/gitconfig` or fontconfig write is required.
Managed source cloning keeps its separate no-system-config/skip-smudge/pointer
refusal contract. Root Computer recipes need the selected runtime bin/config
in their base-side environment as well.

New runtime code refuses missing or malformed asset inventories and missing,
foreign-owned, linked or nonexecutable required files. Child metadata uses the
same inherited read-only unmapped-root policy as its runtime. New slim bases
must independently require this capability. Historical runtime archives retain
their original code and closure checks; no manifest, receipt, active-runtime,
base pin or legacy branch is rewritten. Local Personal and organization-local
environments retain their current tools; cloud runtime selection remains exact
across owners, generations and resident transfers.

The ordinary closure probe checks LFS and font families as UID/GID 10003. It
mounts a disposable read-only Git helper selector at the same physical path as
an installed runtime and supplies the shared asset environment. This matters
even when the runtime is first on PATH: Git prepends its exec-path and binary
directory, where a build runner can have its own LFS. Both plain `git lfs version`
and the exact configured filter's shell prefix must report the pinned version.
Native helpers still resolve to the runner's read-only `/usr`; no host
installation or archive byte changes. Historical
archives without either asset marker retain their original probe environment.
Font checks require both the exact family and its bundled package path, so a
different family in the right package cannot satisfy the probe. Failures report
closed `runtime_system_assets_` sub-checks for identity,
inventory, files, environment, Git selection/version, filter configuration and
each required font package; native output and arbitrary paths stay private.

`cloud-runtime-system-assets-probe.test.ts` runs in the ordinary Linux Vitest
suite without an opt-in. It stages nine synthetic packages through the real
stager, then exercises the actual probe and namespace with real Git/fontconfig,
small original TrueType fonts and a conflicting runner LFS. Its controlled
system-font directory includes higher-revision copies of bundled families and
stock-only Liberation. Tests cover nested package paths, an already populated
stock cache, families beyond the seven probe queries, and refusal of a matching
system font when a bundled family is missing. It covers every sub-check's
failure reporting. The real pinned binary/font payload is also
checked during every bundle build. An additional offline native test accepts an
already acquired tree (including its
`bin/node`) or a complete runtime:

```sh
ZEROS_RUNTIME_SYSTEM_ASSETS_TEST_DIR=/absolute/path/to/runtime \
  pnpm exec vitest run scripts/__tests__/cloud-runtime-system-assets-native.test.ts \
  scripts/__tests__/cloud-runtime-git-lfs-security.test.ts
```

The security regressions execute that tree's actual `bin/git-lfs` with a fresh
HOME, synthetic Git objects and a loopback HTTP fixture. They require no Git
credentials or external server: encoded credential-protocol delimiters must
not redirect the helper to another host, and checkout through symbolic or hard
links must leave files outside the working tree unchanged.

Set `ZEROS_RUNTIME_SYSTEM_ASSETS_CHROMIUM` to the matching Playwright headless
shell to also render multilingual/emoji text, inspect actual Chromium font use,
and validate PNG output. This test keeps the Chromium sandbox enabled and needs
a Linux qualification host with working user namespaces/Chromium sandbox
support. LFS/fontconfig success alone does not qualify browser capture or the
full engine boundary. Qualification must additionally exercise broker-backed
LFS fetch, denied managed pointer cloning and cold Design capture on the new
base/runtime tuple before promotion.

## Verified public asset mirror

`lock.json` names a public mirror at
`https://github.com/Withso/zeros/releases/download/runtime-assets-<lock12>/`.
`lock12` is the first 12 hex digits of SHA-256 over canonical UTF-8 JSON with
recursively sorted keys, compact separators and no trailing newline, excluding
only the top-level `mirror` field. Each asset is named by its full pinned SHA-256.

The build tries the mirror first, then the canonical Ubuntu archive after any
mirror HTTP/network/size/hash failure. Both sources pass the same bounded exact
length and SHA-256 checks before bytes are used. The pinned InRelease signature,
index and package/source chain remain mandatory. Before every initial fetch
and redirect hop, one shared guard requires HTTPS at its default port, no
userinfo or fragment, and an exact allowed host: `archive.ubuntu.com`,
`snapshot.ubuntu.com` (historical archive pins), `github.com`,
`release-assets.githubusercontent.com` or `objects.githubusercontent.com`.
IP literals, other hosts and non-default ports are rejected before any request;
there are no wildcard hosts. Redirects are limited to five hops with a shared
120-second deadline and omitted credentials. The maintainer's fixed release
metadata request uses the same guard with only `api.github.com` allowed, a
30-second deadline and no redirects. Logs contain only the source label and
digest, never signed redirect URLs. Failure of both sources fails the build.
Build downloads need no credentials or workflow secrets.

Maintainers run from the repository root:

```sh
node scripts/cloud-workspace-validation/runtime-bundle/mirror-assets.mjs
node scripts/cloud-workspace-validation/runtime-bundle/mirror-assets.mjs --apply
```

The default prints a complete offline plan and makes no network requests or
writes. `--apply` uses the maintainer's `gh` identity for the public repository.
It first downloads and verifies every file from its canonical archive, then
creates or uses the marked prerelease `runtime-assets-<lock12>` (never the latest
application release). Existing assets are downloaded and hashed before being
skipped; missing assets are uploaded without `--clobber` and downloaded again
for verification. Corrupt existing assets fail explicitly. Rerunning completes
an interrupted upload without replacing verified assets.

The release contains 33 files: noble and resolute InRelease, six indexes, nine
binary packages, 13 retained font source/build files and the three MPL go-uuid
source/build files. Fonts remain on noble; Git LFS 3.7.1 and its required MPL
sources use resolute's independently verified signed metadata. Its notes map
each digest to the original filename. GPL/MPL
source and build recipes therefore accompany the mirrored binaries.

After **any lock change**, rerun the dry-run, set `mirror` to the new URL it
prints, rerun the asset/license checks, and apply the new mirror before merging
or building the runtime. A stale mirror field is rejected by the build and by
`--apply`. Preserve older releases for archived runtime pins; never edit old
release assets in place. No package script or workflow definition is needed.

Four outputs are produced:

- `r1-<manifest-sha256>.tar.gz`: deterministic level-9 gzip/POSIX tar. The first
  member is `manifest.json`; all remaining members follow its byte-sorted inventory.
- `manifest.json`: exactly the first member's bytes; recursive sorted keys,
  no whitespace/newline, build paths, timestamps, or run IDs.
- `descriptor.json`: the shared Cloud v2 runtime descriptor.
- `build-receipt.json`: sizes, counts, largest 15 files, durations, toolchain,
  ELF requirements and offline closure checks. These measurements do not affect identity.

`expandedBytes` sums regular payload sizes in the manifest (excluding the
manifest itself). `fileCount` counts those regular files; `entryCount` also
counts directories and links. The 2.5 GiB expanded-size guideline is reported
as `exceedsSizeGuidance`, not silently used to drop dependencies.

The producer and verifier share the contract limits: archive size 1 byte–2 GiB,
expanded payload 1 byte–4 GiB (individual empty files are allowed), at most
250,000 inventory entries, a 64 MiB manifest, 16 KiB per-entry PAX payloads and
4,096 UTF-8 bytes per path/link target. Paths have at most 128 components;
symlink resolution is bounded to 64 links and 4,096 pending path components.
Protocol/ABI integers are 1–65,535; agent versions use the shared 64-character
ASCII grammar. Compressed output is bounded while streaming, and the verifier
checks archive size before hashing or decompressing it.

Archive verification opens one regular file with `O_NOFOLLOW` and uses its
descriptor for metadata checks, hashing and decompression, so path replacement
cannot substitute a different archive between those operations. Node download
bytes remain in memory until their SHA-256 matches the pinned distribution's
official HTTPS `SHASUMS256.txt` entry; only verified bytes are written to disk.

The payload preserves the production pnpm graph, installed Linux x64 optional
SDK packages, peers and workspace packages, plus `tsx` and TypeScript. Its
source slices, individual source dependencies and single append-only helper
inventory live in `closure.ts`. The unbundled engine also imports the public
channel-policy module under `apps/desktop/shared` and its control-plane JSON;
both files are required even when the bundled CLI's `--help` succeeds.
Copies preserve package topology with internal relative links; regenerated
`.bin` shims invoke the bundled Node. pnpm metadata, browser `.links`, install
validation markers, native build intermediates, non-target embedded PTY/SSH helpers,
upstream SQLite/PTY prebuilds, secrets and caches are omitted. The Octokit auth-token
README and SSH2/Zod test fixtures containing credential examples are omitted;
their package code and license/NOTICE files remain unchanged. The source-built
SQLite addon also fills the Linux platform export's prebuild slot. Everything
else in the selected dependency packages, including notices, is retained.
Claude's SDK tries the musl package as a fallback even on glibc, so both Linux
x64 variants remain in the closure.

Node's complete upstream license/provenance lives in `lib/node/`; package
licenses remain beside their packages and the Linux dependency inventory is
`worker/runtime-dependencies.json`. Playwright 1.59.1 installs its pinned Ubuntu
24.04 Chromium headless-shell and FFmpeg assets with their original notices.
The unused headed Chromium download is omitted with `install --only-shell
chromium`; cloud capture already selects the shell with `headless: true` and no
channel. The offline closure probe resolves that exact shell from the staged
Playwright registry, verifies its runtime-local executable and version, and
requires its license. The opt-in native asset suite exercises default sandboxed
headless launch, bundled-font rendering, PNG output and process exit with full
Chromium absent (`ZEROS_RUNTIME_SYSTEM_ASSETS_HEADLESS` names the acquired shell
binary; `ZEROS_RUNTIME_SYSTEM_ASSETS_TEST_DIR` names the staged asset/runtime
tree). Runtime/base capture qualification remains required before admission;
archive closure never grants VM authority. Local capture still uses Electron.

The manifest lists `selfTest` only when B7's regular self-test file is included;
every listed entrypoint must be a regular inventory file. B2's runtime-root
resolver is required and copied from its engine source as a regular file at
`lib/zeros/cloud-runtime-root.mjs`; B7's self-test is included when present.
The inventory also includes the runtime-only legacy ownership-adoption and
root workload-custody publication helpers, plus the readonly resource-budget
reader. Cloud Host supervision uses the
fixed `host-process-supervisor.mjs`, `cloud-host-workload-entry.mjs` and
`cloud-workload-cgroup.mjs` source modules; staging requires regular files and
the offline probe checks each module's syntax. Neutral ripgrep is staged as
`worker/binaries/rg`. Retired ZSR binaries, qualification sources and the
sandbox-runtime dependency are omitted. Archived artifact and base readers
retain their existing keys; this builder does not publish artifacts.

The build always verifies the archive, rehashes its extracted tree, and probes
it at `/opt/zeros-infra/<runtimeId>` in a mount/network namespace. Only the
runtime, OS tools/libraries, devices and a read-only proc view are mounted; the
checkout/store and their parent directories are absent from module resolution.
Namespace setup maps payload ownership to root, then both engine and Cursor
probes run as UID/GID 10003. The map is installed before read-only proc; Cursor
does not attempt a nested user namespace (#410). Disposable v4 marker,
active-runtime and facade fixtures let source imports exercise B2's resolver.
Their synthetic base/receipt/session identities are never archived and do not
qualify a real base installation.
It loads SQLite, PTY, Cursor, engine externals, the complete source `ZerosEngine`
export and source qualification modules;
runs Claude/Codex versions, LSP/compiler shims, engine help, Host module syntax
and ripgrep checks; and resolves the pinned browser assets. The pinned Cursor
platform executables are checked with `--version`/`--help`, including missing
file and execute-bit refusals. These offline mount/network namespaces are
builder checks, not an agent sandbox or a production controller exemption.
Production runs share one non-root engine identity and workspace VM trust domain.
Browser launch, shared workload entry/drain, live provider turns and privileged
runtime self-test belong to base/runtime qualification.

Fast tests and opt-in real-archive acceptance:

```sh
pnpm exec vitest run scripts/__tests__/cloud-runtime-bundle.test.ts scripts/__tests__/cloud-runtime-bundle-closure.test.ts -t '^(?!Cursor platform payload closure)'
pnpm exec vitest run scripts/__tests__/cloud-runtime-bundle.test.ts -t 'Cursor platform payload closure'
ZEROS_RUNTIME_BUNDLE_TEST_DIR=.context/runtime-bundle pnpm exec vitest run scripts/__tests__/cloud-runtime-bundle-closure.test.ts
```

The first command is portable. The Cursor command uses real Linux namespaces;
run it in an available native qualification lane. Real-archive acceptance also
uses namespaces and remains opt-in via the bundle directory.

For reproducibility, build the same clean commit twice into distinct output and
work directories using the same host toolchain. Compare the manifest, descriptor
and archive bytes; receipt durations are deliberately different. The archive
writer also has independent readback, relocation and deterministic fixture tests.
