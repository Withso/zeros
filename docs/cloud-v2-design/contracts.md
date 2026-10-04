# Cloud v2 Phase B — shared contracts (orchestrator-owned; authoritative for B1–B8)

Parallel PRs implement these exact shapes. B1 owns the TypeScript definitions in
`packages/protocol/src/cloud-runtime-bundle.ts` (zod schemas + types + golden fixtures under
`packages/protocol/src/__tests__/fixtures/cloud-runtime/`). Python (base bootstrap) consumes the
same golden fixtures in its tests. If an implementer needs a change, report it to the orchestrator
instead of diverging. All hex digests are lowercase SHA-256 (64 chars). All JSON is UTF-8; object
keys are ASCII.

## 1. Paths
- `R = /opt/zeros-infra/<runtimeId>` — immutable installed runtime (root-owned, no group/other write,
  every regular file nlink=1).
- `R/bin/node`, `R/bin/start-engine.sh`, `R/bin/cloud-engine-namespace` (0500),
  `R/bin/cloud-process-supervisor` (0555)
- `R/worker/` — same relative layout as today's `/opt/zeros` (dist-engine/, node_modules/,
  package.json, apps/desktop/src/..., packages/..., binaries/, scripts/cloud-workspace-validation/...,
  design-browsers/).
- `R/lib/zeros/` — the helper set that today lives in `/opt/zeros-runtime/lib/zeros` (19 files +
  the runtime-root resolver).
- `R/manifest.json` — canonical manifest (§2).
- Facade: `/opt/zeros/{current,previous,bin,worker,manifest.json,sessions/,logs,state,disk-epoch}`;
  `/zeros -> /opt/zeros` via tmpfiles; `bin -> current/bin`, `worker -> current/worker`,
  `manifest.json -> current/manifest.json`, `logs -> /srv/zeros/log`, `state -> /srv/zeros/state`.
- Bootstrap (base-owned): `/opt/zeros-bootstrap/{boot.sh,dispatch.sh,install-runtime.sh,bootstrap.py,compatibility.json}`.
- Receipts: `/srv/zeros/runtime-installs/<runtimeId>.json`. Active descriptor: `/run/zeros/active-runtime.json`.
- Host marker (v4): `/etc/zeros/cloud-worker.json` with `"version": 4`; base provenance `/etc/zeros/base-build.json`.

## 2. Runtime manifest — `manifest.json`
Produced only by the bundle builder (B3). Bytes = `JSON.stringify(value)` of an object whose keys
are inserted in sorted order at every level (recursive), no whitespace, no trailing newline.
Determinism: no timestamps, hostnames, absolute build paths or run ids inside the manifest.
`manifestSha256 = sha256(raw manifest bytes)`; `runtimeId = "r1-" + manifestSha256`.
Consumers verify the raw bytes' digest; they never re-serialize.

```json
{
  "agents": {"claude": {"cli": "2.1.288", "sdk": "0.3.288"},
             "codex": {"package": "0.160.0"},
             "cursor": {"sdk": "1.0.35"}},
  "entrypoints": {"node": "bin/node", "setup": "lib/zeros/setup-cloud-workspace.mjs",
                  "startEngine": "bin/start-engine.sh", "supervisor": "lib/zeros/cloud-worker-supervisor.mjs",
                  "selfTest": "lib/zeros/runtime-self-test.mjs"},
  "files": [
    {"mode": "0755", "path": "bin", "type": "dir"},
    {"mode": "0555", "path": "bin/node", "sha256": "<hex>", "size": 123, "type": "file"},
    {"path": "worker/node_modules/x", "target": "../.pnpm/x@1.0.0/node_modules/x", "type": "symlink"}
  ],
  "platform": {"arch": "x64", "libc": "glibc", "minGlibc": "2.39", "node": "22.23.1",
               "nodeModulesAbi": 127, "os": "linux"},
  "protocols": {"bootstrap": 1, "engine": 20, "setup": 2},
  "schema": "zeros.runtime-manifest/v1",
  "source": {"commit": "<40-hex>", "lockfileSha256": "<hex>"}
}
```
Rules: `files` sorted by `path` (byte order); paths are relative, `/`-separated, no `.`/`..`
segments, no leading `/`, no NUL; types `dir|file|symlink` only; modes are 4-digit octal strings
without setuid/setgid/sticky bits and without group/other write; symlink targets are relative and
must resolve (lexically and after resolving earlier links) inside R; `manifest.json` itself is not
listed. The manifest must list every entry in the archive except `manifest.json`.

## 3. Archive
`<runtimeId>.tar.gz`: POSIX ustar/pax tar, gzip (level 9, mtime 0 in the gzip header, no file
name). First member is `manifest.json` (mode 0444). Then every manifest entry in `files` order.
All headers: uid/gid 0, uname/gname empty, mtime 0. Only per-entry PAX `path`/`linkpath` records
are allowed (for long names); no global PAX, no hard links, devices, FIFOs, sparse files, xattrs,
ACLs or capabilities. `archiveSha256`/`archiveBytes` cover the exact gzip bytes.

## 4. Runtime descriptor (registry row ↔ admission)
```ts
type RuntimeDescriptor = {
  runtimeId: string;              // "r1-" + manifestSha256
  manifestSha256: string;
  archiveSha256: string;
  archiveBytes: number;           // integer > 0
  expandedBytes: number;          // sum of file sizes
  sourceCommit: string;           // 40 hex
  nodeModulesAbi: number;
  bootstrapProtocolVersion: 1;
  engineProtocolVersion: number;
};
```

## 5. Installer input (stdin of the fixed installer command; base64url of this JSON)
```ts
type RuntimeInstallInput = {
  schema: "zeros.runtime-install/v1";
  purpose: "workspace-setup" | "build" | "qualification";
  runtime: RuntimeDescriptor;
  artifact: { url: string; expiresAt: string }; // https only; host must match base allowlist
  setup?: string;  // ONLY for purpose=workspace-setup: the existing setup payload
                   // (today's ZEROS_CLOUD_WORKSPACE_SETUP_B64 value), passed unchanged on stdin
                   // to R's setup helper after a successful install.
};
```
Fixed command: `/usr/bin/flock --exclusive --nonblock /run/zeros/setup.lock /opt/zeros-bootstrap/install-runtime.sh --stdin`.
Bound: 64 KiB encoded input. Never logged. Exit code 0 only when (install ok) and (for
workspace-setup) the setup helper exited 0.

## 6. Installer receipt — `/srv/zeros/runtime-installs/<runtimeId>.json`
```json
{"archiveSha256":"<hex>","baseCompatibilityId":"bc1-<hex>","bootstrapVersion":1,"expandedBytes":1,
 "fileCount":1,"installedAt":"<RFC3339>","manifestSha256":"<hex>","runtimeId":"r1-<hex>",
 "schema":"zeros.runtime-install-receipt/v1"}
```
`installerReceiptSha256 = sha256(raw receipt bytes)`.

## 7. Active runtime descriptor — `/run/zeros/active-runtime.json` (root 0600; engine gets a read-only projection)
```json
{"baseCompatibilityId":"bc1-<hex>","bootId":"<kernel boot_id>","cgroupRoot":"/sys/fs/cgroup/...",
 "installerReceiptSha256":"<hex>","manifestSha256":"<hex>","root":"/opt/zeros-infra/r1-<hex>",
 "runtimeId":"r1-<hex>","schema":"zeros.active-runtime/v1","supervisorSessionId":"<uuid>"}
```
Code that needs the runtime root reads ONLY this descriptor (via the B2 resolver); never env vars.

## 8. Base compatibility — `/opt/zeros-bootstrap/compatibility.json`
```json
{"arch":"x64","artifactHostSuffixes":[".r2.cloudflarestorage.com"],"bootstrapProtocolVersion":1,
 "glibc":"2.39","os":{"id":"ubuntu","versionId":"24.04"},
 "protectedFiles":[{"mode":"0555","path":"/opt/zeros-bootstrap/bootstrap.py","sha256":"<hex>"}],
 "schema":"zeros.base-compatibility/v1","supportedManifestSchemas":["zeros.runtime-manifest/v1"],
 "systemdMin":254,"uids":{"agent":10001,"capture":10002,"coordinator":10004,"engine":10003}}
```
`baseCompatibilityId = "bc1-" + sha256(raw compatibility.json bytes)`. compatibility.json does not
list itself. Phase C's protected-file check uses `protectedFiles` + the runtime manifest.

## 9. Closed diagnostic (last stdout line of installer / attester / self-test / smoke, and CI logs)
```ts
type ClosedDiagnostic = {
  schema: "zeros.diagnostic/v1";
  component: "bundle" | "publication" | "base" | "bootstrap" | "installer" | "attester" |
             "setup" | "qualification" | "cleanup" | "build";
  stage: string;          // enum per component (snake_case constants only)
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  failedChecks: string[]; // snake_case constants only, deduplicated, ≤ 32
};
```
No free text, paths, URLs, tokens, stderr or exception messages in any field.

## 10. Installer stages and checks (enums)
Stages: `validate_input`, `lock`, `check_space`, `check_cache`, `download`, `verify_archive`,
`verify_manifest`, `extract`, `verify_tree`, `publish_receipt`, `switch_pointer`, `start_host`,
`run_setup`, `done`.
Checks include: `input_schema`, `input_too_large`, `artifact_host`, `artifact_expired`,
`insufficient_space`, `cache_conflict`, `http_status`, `download_truncated`, `archive_digest`,
`archive_size`, `manifest_digest`, `manifest_schema`, `bootstrap_protocol`, `archive_paths`,
`archive_member_type`, `file_inventory`, `file_digest`, `file_mode`, `symlink_escape`,
`root_ownership`, `hard_link`, `pointer_publish`, `host_start`, `setup_exit`, `timeout`,
`process_signal`, `diagnostic_missing`.

## 11. Entry points and probes
- Setup helper (unchanged contract): `<node> <lib>/setup-cloud-workspace.mjs --stdin` reads the
  existing setup document from stdin. On v4 the installer, after a successful install and host
  start, runs `R/bin/node R/lib/zeros/setup-cloud-workspace.mjs --stdin` and writes the nested
  `setup` string of the installer input to its stdin; the installer's exit code mirrors the
  helper's (plus its own diagnostic).
- Root supervisor on v4: started ONLY by `zeros-host.service` → `/opt/zeros-bootstrap/dispatch.sh`
  → `exec R/bin/node R/lib/zeros/cloud-worker-supervisor.mjs` (no arguments; it detects v4 from
  `/etc/zeros/cloud-worker.json` version 4 and reads `/run/zeros/active-runtime.json` through the
  B2 resolver). The legacy `ensure-cloud-worker-supervisor.mjs` detached spawn is never used on v4.
- Base status probe (provider exec, no input, no secrets):
  `/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/bootstrap.py status` → exactly one
  JSON line `{"baseCompatibilityId":"bc1-<hex>","bootId":"<id>","currentRuntimeId":"r1-<hex>"|null,
  "hostState":"idle"|"waiting_for_runtime"|"stopped"|"failed","schema":"zeros.base-status/v1"}`.
- Runtime self-test (used by the runtime-smoke qualification, B7):
  `R/bin/node R/lib/zeros/runtime-self-test.mjs` (root, no input) → runs engine/native/containment
  self-checks that need no model credentials and prints one closed diagnostic line
  (component `qualification`). B3 includes it in the bundle when present; B7 implements it.

## 12. Host marker and child-helper path derivation (answers to B2, 2026-10-04)
- v4 host marker `/etc/zeros/cloud-worker.json` (base-owned, written by the B4 base build; it
  cannot name runtime paths because R changes per installed runtime) contains exactly:
  `{"backend":"cloud-worker","gid":10001,"profile":"zeros-cloud-worker-v4","uid":10001,"version":4}`.
  The engine's read-only projected marker adds the concrete `toolchain` paths derived from the
  active runtime descriptor (§7).
- Children launched inside restricted views (coordinator/agent views that cannot see
  `/etc/zeros` or `/run/zeros`) derive R from their pinned executable: `process.execPath` must be
  exactly `R/bin/node` where R matches `/opt/zeros-infra/r1-<64 hex>`, is a real root-owned
  directory not writable by group/other with no symlink in its ancestry; otherwise fail closed.
  No environment-variable or argument override. Launchers always start such children with the
  concrete `R/bin/node` path (never `/zeros/...` or `/opt/zeros/current/...`).
