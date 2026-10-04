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
output uses closed, value-free diagnostics. No provider credentials are needed.

Host requirements: Linux x64 with glibc, a C/C++ toolchain supporting C++20,
make, Python 3, Git, GNU tar/xz, readelf, bubblewrap and util-linux (`setpriv`).
User/mount/network namespaces must be enabled. CI's target is Ubuntu 24.04;
Amazon Linux 2023 can build and run the offline module checks. No Docker is used.
The build downloads Node 22.23.1 from nodejs.org, verifies its official SHA-256
checksum, bootstraps pnpm 10.28.0, and uses that Node for both native rebuilds.
Installed ELF objects must be x86-64 and require no GLIBC newer than 2.39.
The receipt records GLIBCXX/CXXABI and library needs for base qualification.
It does not claim to qualify host containment or the base's OS libraries.

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
source slices and single append-only helper inventory live in `closure.ts`.
Copies preserve package topology with internal relative links; regenerated
`.bin` shims invoke the bundled Node. pnpm metadata, browser `.links`, install
validation markers, native build intermediates, non-target embedded SRT/PTY/SSH helpers,
upstream SQLite/PTY prebuilds, secrets and caches are omitted. The Octokit auth-token
README and SSH2/Zod test fixtures containing credential examples are omitted;
their package code and license/NOTICE files remain unchanged. The source-built
SQLite addon also fills the Linux platform export's prebuild slot. Everything
else in the selected dependency packages, including notices, is retained.
Claude's SDK tries the musl package as a fallback even on glibc, so both Linux
x64 variants remain in the closure.

Node's complete upstream license/provenance lives in `lib/node/`; package
licenses remain beside their packages and the Linux dependency inventory is
`worker/runtime-dependencies.json`. Playwright 1.59.1 installs the Ubuntu 24.04
Chromium, headless-shell and FFmpeg assets with their original notices.

The manifest lists `selfTest` only when B7's regular self-test file is included;
every listed entrypoint must be a regular inventory file. B2's runtime-root
resolver is required and copied from its engine source as a regular file at
`lib/zeros/cloud-runtime-root.mjs`; B7's self-test is included when present.
This builder does not implement these helpers or publish artifacts.

The build always verifies the archive, rehashes its extracted tree, and probes
it at `/opt/zeros-infra/<runtimeId>` in a mount/network namespace. Only the
runtime, OS tools/libraries, devices and a read-only proc view are mounted; the
checkout/store and their parent directories are absent from module resolution.
It loads SQLite, PTY, Cursor, engine externals and source qualification modules;
runs Claude/Codex versions, LSP/compiler shims, engine help and ZSR syntax/ripgrep
checks; and resolves the pinned browser assets. Browser launch, live provider
turns and privileged runtime self-test belong to base/runtime qualification.

Fast tests and opt-in real-archive acceptance:

```sh
pnpm exec vitest run scripts/__tests__/cloud-runtime-bundle.test.ts scripts/__tests__/cloud-runtime-bundle-closure.test.ts
ZEROS_RUNTIME_BUNDLE_TEST_DIR=.context/runtime-bundle pnpm exec vitest run scripts/__tests__/cloud-runtime-bundle-closure.test.ts
```

For reproducibility, build the same clean commit twice into distinct output and
work directories using the same host toolchain. Compare the manifest, descriptor
and archive bytes; receipt durations are deliberately different. The archive
writer also has independent readback, relocation and deterministic fixture tests.
