# Runtime Git LFS and Design font provenance

These notices, the public archive key and `lock.json` accompany the Linux x64
runtime's Git LFS and eight Design font packages. They do not install software
on the base or Computer guest. `runtime-bundle/system-assets.ts` acquires and
extracts the pinned archives on the bundle build host, then the normal immutable
runtime inventory covers their selected contents.

The eight font pins come from Ubuntu noble's release pocket, signed on
2024-04-25. Git LFS 3.7.1-1 comes from Ubuntu resolute's release pocket,
signed on 2026-04-23. Both use Ubuntu's 2018 archive key:

```
F6ECB3762474EDA9D21B7022871920D1991BC93C
```

The fingerprint is published in the Ubuntu Security Team's
[archive-signing documentation](https://wiki.ubuntu.com/SecurityTeam/FAQ).
`ubuntu-archive-2018.asc` contains only its public key. InRelease, compressed
Packages/Sources indexes, binary packages, package copyrights and required source
archives have independent SHA-256 pins. The build verifies the clear signature
in an isolated keyring with key retrieval disabled, then follows the signed
index chain. A package version or architecture mismatch fails even if its URL
returns bytes. Each package/source selects its own signed release pocket;
an index from another pocket cannot authorize it. Release Date and the absence
of Valid-Until are pinned and checked for both immutable release pockets.
These are explicit historical pins, not a rolling freshness selection; no
current-security or updates pocket silently changes the artifact.

Git LFS 3.7.1 includes the fixes for CVE-2024-53263 (credential-protocol
injection, fixed in 3.6.1) and CVE-2025-26625 (checkout/pull writes through
links, fixed in 3.7.1). The resolute executable requires at most GLIBC 2.34 and
passes the runtime's existing noble/GLIBC 2.39 ABI gate. The actual staged
executable has offline regressions for both vulnerabilities. No wrapper or
environment setting substitutes for the fixed executable.

Each package directory holds its exact extracted `usr/share/doc/<name>/copyright`.
The GPL/Apache/GFDL common license texts come from the pinned noble `base-files`
package; `copyright.common-licenses` preserves its notice. Original notices can
mention files or test material outside the selected payload; retaining them does
not imply those files are executed or bundled as separate products.

Git LFS's 27 static Go dependencies are listed by its authenticated
`Static-Built-Using` field. The builder checks that exact field alongside the
executable pin; `pnpm check:licenses` requires complete notice coverage.
`git-lfs/LICENSE.upstream` is the v3.7.1 notice from the signed resolute source
archive. The `copyright.<source-package>` files are exact packaging notices
for those versions, with source URL/archive SHA-256/text SHA-256 recorded in
`gitLfsNotices`. Twenty-three come from signed resolute source metadata, and
two from signed Ubuntu snapshot metadata at `20251115T000000Z`. The exact Go
1.25.0 and Cobra 1.10.1 notice archives come from the official Ubuntu pool and
snapshot archive over HTTPS. Their `authenticatedIndex` is null: these are
reviewed, hash-pinned notice sources, not an asserted signed-index chain.
Runtime executable/font acquisition always requires the signed chain above.

The MPL-2.0 go-uuid source and Debian recipe remain under `sources/`; the build
also verifies them through resolute's signed Sources index before reusing the
exact immutable vendored copies. The four GPL font source packages and Debian
recipes are fetched through noble's signed Sources indexes. All required GPL
and MPL source/build files accompany both the runtime and the public mirror.

To update a pin:

1. Verify the intended Ubuntu archive signing fingerprint through its official
   documentation. Retain a public key only; never add private key material.
2. Download and verify InRelease in a fresh, isolated GnuPG home. Verify index
   lengths/SHA-256 against the signed Release and the selected package and source
   records against those indexes. Record exact versions, architecture, URLs,
   byte lengths and SHA-256 in `lock.json`.
3. Extract with the build's checked `dpkg-deb -x` helper; copy the selected
   package copyrights exactly. For a new Git LFS binary, refresh every static Built-Using
   notice and any required source distribution, retaining source provenance.
4. Run `pnpm licenses:generate`, `pnpm check:licenses`, the asset/bundle tests,
   and the offline native asset tests. Build and verify a clean runtime archive
   on a host with GnuPG, dpkg-deb and the other documented build prerequisites.
   Qualify actual LFS and sandboxed Design capture before base/runtime promotion.
5. After any lock edit, run
   `node scripts/cloud-workspace-validation/runtime-bundle/mirror-assets.mjs`
   from the repository root. Set `mirror` to the newly computed URL in that
   offline plan, then run the same command with `--apply` using your `gh`
   identity. Publish the new mirror before merging/building; retain old releases.

The public, content-addressed mirror includes every build download and all
retained GPL/MPL source/build archives. It needs no build credentials. Mirror
bytes must pass the same pinned size/hash checks and signed metadata chain as
canonical archive bytes. See the [mirror process](../../scripts/cloud-workspace-validation/runtime-bundle/README.md#verified-public-asset-mirror)
for canonical lock hashing, prerelease publication, idempotent verification and
fallback behavior.

`pnpm check:licenses` validates the vendored notice/source hashes and exact
Built-Using notice coverage. No permission is inferred from a download URL; the
retained license texts govern redistribution. Existing archived runtime pins and
their serialized contracts are never edited by a pin refresh.
