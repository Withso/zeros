# M-A — Boat lifecycle timings for Cloud Computer v2

Measured on 2026-10-04 UTC, 2026-10-04T09:42:41.731071+00:00 through 2026-10-04T09:50:39.768309+00:00; final independent read-only audit at 2026-10-04T09:51:47.484529+00:00.

Boat reached a command-ready state in 3.52–5.12 s and first successful `true` in 3.92–5.57 s. Stopping was the longer lifecycle boundary: 41.91–43.26 s. All four stopped-template forks preserved the marker and continued working after source-template deletion. The optional named snapshot took 47.08 s to save. Eight starts created seven sandboxes; every created ID and the one test snapshot now returns GET 404. Physical deletion receipts remain blocked on upload fences, so byte erasure is pending.

## Source, budget and method

The public [Alpha release identity](https://api-alpha.zeros.build/v1/release-identity) returned HTTP 200, channel `alpha`, worker source `aa11196c97a6`, and snapshot `zeros-qualification-aa11196c97a6`. The snapshot was ready and reported 6,945,722,368 bytes (6.47 GiB). Every sandbox was created from this configured Alpha snapshot; no default-image fallback was used. Alpha reported `workerQualified=false`; this experiment measured Boat lifecycle behavior and did not qualify Zeros agents or the worker image.

Each allocation used Boat `default` (4 vCPU, 8 GB), `noEnv=true`, empty per-sandbox env, snapshots enabled, and a finite TTL (1800 s for the main run, 600 s for the supplementary download VM). Every Boat request sent `X-Boat-Org` from `BOAT_BILLING_ORG`; every ready sandbox confirmed that billing org. Boat requests used Python `urllib` with redirects refused. Creates and forks used idempotency keys; no ambiguous dispatch recovery or extra dispatch was needed. Sandbox display names were set by PATCH immediately after allocation because naming is a separate API operation.

Budget: 3 creates + 1 resume + 4 forks = **8/10 starts**. The first create produced a valid lifecycle sample but its file scan failed and the VM was deleted; the main experiment was repeated. The third create supplied the requested 30–50 MB public archive sample after the first archive proved slightly larger. Initial `/limits` showed 0 active sandboxes and 200 daily / 60 hourly / 12 minute starts available. The final audit shows 0 active sandboxes, 8 daily/hourly starts used, and 192/52 remaining. The original Alpha base is still ready with unchanged reported size.

Lifecycle times use a monotonic clock from before the POST until the response observing the state, and separately until synchronous `true` returns HTTP 200 / exit 0. State polling sleeps 1 s between requests, so observations can lag the actual transition by about 1 s plus network latency. Display naming and polling are included in request-to-state/exec times. Local `sha256sum`, transfer and extraction times are measured inside the VM; API wall times also include command startup and transport.

Evidence: [results.json](/home/vercel-sandbox/zeros/.context/impl/boat-timings/results.json), [run-1-results.json](/home/vercel-sandbox/zeros/.context/impl/boat-timings/run-1-results.json), [http-events.jsonl](/home/vercel-sandbox/zeros/.context/impl/boat-timings/http-events.jsonl), [final-audit.json](/home/vercel-sandbox/zeros/.context/impl/boat-timings/final-audit.json).

## Measurement distributions

These are small samples, not percentile or availability claims. “Command-ready” accepts observed `ready` or `idle`; `idle` was observed on wake and three of four forks. Stops were timed to `archived` with `snapshotAvailable=true`.

| Measurement | n | Min | Median | Max | Unit |
| --- | ---: | ---: | ---: | ---: | --- |
| Create from Alpha snapshot, including supplementary VM: request → HTTP 202 | 3 | 0.606 | 0.634 | 0.874 | s |
| Create from Alpha snapshot, including supplementary VM: request → command-ready state | 3 | 3.766 | 4.021 | 5.118 | s |
| Create from Alpha snapshot, including supplementary VM: request → first successful `true` | 3 | 4.142 | 4.393 | 5.566 | s |
| Wake: request → HTTP 202 | 1 | 0.494 | 0.494 | 0.494 | s |
| Wake: request → command-ready state | 1 | 4.652 | 4.652 | 4.652 | s |
| Wake: request → first successful `true` | 1 | 5.037 | 5.037 | 5.037 | s |
| Single stopped-template fork: request → HTTP 202 | 1 | 0.356 | 0.356 | 0.356 | s |
| Single stopped-template fork: request → command-ready state | 1 | 3.523 | 3.523 | 3.523 | s |
| Single stopped-template fork: request → first successful `true` | 1 | 3.918 | 3.918 | 3.918 | s |
| Three concurrent stopped-template forks: request → HTTP 202 | 3 | 0.373 | 0.378 | 0.383 | s |
| Three concurrent stopped-template forks: request → command-ready state | 3 | 3.568 | 3.572 | 4.837 | s |
| Three concurrent stopped-template forks: request → first successful `true` | 3 | 3.944 | 3.959 | 5.208 | s |
| Template stop: request → HTTP 202 | 2 | 0.292 | 0.294 | 0.295 | s |
| Template stop: request → archived | 2 | 41.905 | 42.584 | 43.263 | s |
| VM facts probe, including directory metadata enumeration: API wall time | 2 | 11.785 | 13.308 | 14.831 | s |
| Original user tree scan (FAILED, partial; excluded from valid read comparisons) | 1 | 13.229 | 13.229 | 13.229 | s |
| 2.50 GiB runtime tree checksum: cold pass | 1 | 11.608 | 11.608 | 11.608 | s |
| Runtime tree cold probe: API wall time | 1 | 12.327 | 12.327 | 12.327 | s |
| 2.50 GiB runtime tree checksum: warm pass | 1 | 2.198 | 2.198 | 2.198 | s |
| Runtime tree warm probe: API wall time | 1 | 2.617 | 2.617 | 2.617 | s |
| gzip, 56.646 MB: download | 1 | 0.743 | 0.743 | 0.743 | s |
| gzip, 56.646 MB: sha256sum | 1 | 0.030 | 0.030 | 0.030 | s |
| gzip, 56.646 MB: extraction | 1 | 0.849 | 0.849 | 0.849 | s |
| gzip, 56.646 MB: complete probe: API wall time | 1 | 2.188 | 2.188 | 2.188 | s |
| gzip, 56.646 MB: download throughput | 1 | 72.661 | 72.661 | 72.661 | MiB/s |
| xz, 30.738 MB: download | 1 | 0.447 | 0.447 | 0.447 | s |
| xz, 30.738 MB: sha256sum | 1 | 0.048 | 0.048 | 0.048 | s |
| xz, 30.738 MB: extraction | 1 | 3.865 | 3.865 | 3.865 | s |
| xz, 30.738 MB: complete probe: API wall time | 1 | 5.724 | 5.724 | 5.724 | s |
| xz, 30.738 MB: download throughput | 1 | 65.539 | 65.539 | 65.539 | MiB/s |
| Wake marker read: API wall time | 1 | 0.446 | 0.446 | 0.446 | s |
| Fork marker read before source deletion: API wall time | 4 | 0.418 | 0.430 | 4.440 | s |
| Fork `true` after source deletion: API wall time | 4 | 0.344 | 0.362 | 0.397 | s |
| Fork marker read after source deletion: API wall time | 4 | 0.377 | 0.460 | 0.811 | s |
| Optional named snapshot save: request → HTTP 202 | 1 | 0.317 | 0.317 | 0.317 | s |
| Optional named snapshot save: request → ready | 1 | 47.077 | 47.077 | 47.077 | s |
| Sandbox deletion: request → HTTP 202 | 7 | 0.286 | 0.295 | 0.300 | s |
| Sandbox deletion: request → GET 404 | 7 | 0.579 | 0.586 | 0.630 | s |
| Named snapshot deletion: DELETE API wall time | 1 | 0.290 | 0.290 | 0.290 | s |

## Individual lifecycle samples

Each concurrent fork was dispatched within 5 ms of the others and is timed from its own request. The sampled state sequence can omit a brief intermediate state.

| Operation | Sandbox | HTTP | Ack s | Observed states | Ready/archived s | First `true` s |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| create | bx_x6m3hs5m | 202 | 0.606 | provisioned → cloning → ready | 3.766 | 4.142 |
| create | bx_v65f7pa8 | 202 | 0.874 | provisioned → cloning → ready | 4.021 | 4.393 |
| stop-1 | bx_v65f7pa8 | 202 | 0.292 | archiving → archived | 41.905 | — |
| resume | bx_v65f7pa8 | 202 | 0.494 | provisioned → cloning → idle | 4.652 | 5.037 |
| stop-2 | bx_v65f7pa8 | 202 | 0.295 | archiving → archived | 43.263 | — |
| fork-serial | bx_rgtefmyh | 202 | 0.356 | provisioning → provisioned → cloning → idle | 3.523 | 3.918 |
| fork-concurrent-2 | bx_8vsyknjn | 202 | 0.373 | provisioning → provisioned → cloning → idle | 3.568 | 3.959 |
| fork-concurrent-1 | bx_vtcpyu3p | 202 | 0.378 | provisioning → provisioned → ready | 3.572 | 3.944 |
| fork-concurrent-3 | bx_epe6xfz8 | 202 | 0.383 | provisioning → provisioned → cloning → idle | 4.837 | 5.208 |
| create-download-probe | bx_tn8pabn5 | 202 | 0.634 | provisioned → cloning → idle | 5.118 | 5.566 |

The marker `/home/user/zeros-v2-test-marker-1.txt` was written before the first stop. It matched after wake, in all four forks before source deletion, and in all four forks afterward. After DELETE of `bx_v65f7pa8`, Boat returned HTTP 202 with operation `bdop_a441acc281a147c981801be86f26cb2b`; GET of the source returned 404. Every fork then returned HTTP 200 / exit 0 for `true`, and a second command read the unchanged marker. The first serial-fork Python marker command took 4.44 s beyond its first `true`, illustrating that a minimal command does not time full language/engine startup.

## VM and disk facts

The complete successful run used sandbox `bx_v65f7pa8`. Boat reported provider `baremetal`, type `default`, 4 vCPU, 8 GB and healthy. `nproc` returned 4; `free -m` reported 7941 MiB RAM and 2047 MiB swap. Ubuntu 24.04.4 LTS ran Linux 6.8.0-117-generic on x86_64. The two queried cgroup-v2 limit files were unavailable; this does not establish that resource limits are absent.

`df -h` reported `/dev/vda1` at 69G total, 20G used, 47G available. `/usr`, `/opt`, `/srv`, and `/home/user` had Boat lazy-filesystem mounts. This is observed root-filesystem capacity, including system storage, rather than a measurement of the advertised user-data allowance.

The selected `/opt/zeros` tree had `du -sb` apparent size 2,685,143,743 bytes (2.50 GiB), compared with about 0.84 GB in `/usr/local/lib/node_modules` and 3.90 GB in `/usr/lib`. `/opt/zeros` was preferred as the requested runtime tree. Apparent size includes metadata/symlinks; exact hashed regular-file bytes were not counted.

The first unprivileged requested pipeline returned exit 123 after 13.229 s: four browser `deb.deps`/`rpm.deps` files were unreadable, and a provider hydration `.ascii-dw` file disappeared during enumeration. That failed partial read is retained separately and excluded from valid cold/warm comparisons. The repeat used privileged reads and excluded only provider scratch files:

```sh
sudo -n find /opt/zeros -type f ! -name '*.ascii-dw' -print0 | sudo -n xargs -0 -r sha256sum > /dev/null
```

Both repeated scans exited 0. The first pass took 11.608 s and the immediate warm pass 2.198 s (5.28× faster). “Cold” means first payload-checksum pass in a freshly created VM; page caches were not evicted, directory metadata had been enumerated, and background hydration/provider caches were uncontrolled. The run therefore does not measure worst-case full-disk hydration.

## Public archive and runtime-install estimates

Both archives were public Node 22.20.0 linux-x64 downloads via Python inside test VMs. Both matched the corresponding entry in upstream `SHASUMS256.txt`; `sha256sum` and extraction exited 0. Each expanded to 197,421,696 bytes of regular files. Temporary archives and extracted trees were removed before subsequent stop or delete.

The [gzip archive](https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.gz) was 56,645,685 bytes (54.02 MiB), slightly beyond the requested approximate range. The supplementary [xz archive](https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz) was 30,737,976 bytes (29.31 MiB / 30.74 MB), within the requested decimal size range. It used a fresh default-sized VM rather than an additional fork because the original test family had already been deleted. Gzip and xz extraction costs are kept separate.

**Inference: linear scaling to a 1 GiB compressed archive**, using the measured bytes and times, gives:

| Codec | Download estimate | Archive hash estimate | Extract estimate | Sum estimate |
| --- | ---: | ---: | ---: | ---: |
| gzip | 14.1 s | 0.6 s | 16.1 s | 30.7 s |
| xz | 15.6 s | 1.7 s | 135.0 s | 152.3 s |

This was not a live 1 GiB install. The estimate excludes signature verification, deployed-file manifest verification, actual runtime admission, atomic publication, and network-route differences between Node's CDN and the runtime store. Gzip ran in the main warmed VM; xz ran in a fresh supplementary VM. The 2.50 GiB first-read scan separately shows an 11.6 s cost when reading a restored tree. Repeat on the actual v4 runtime bundle and chosen codec before treating these estimates as a service target.

## Recommended timeouts and UX targets

These are initial internal-Alpha settings inferred from the samples, with margin; repository checkout, setup scripts, actual org builds and full runtime admission were not measured.

| Phase | Suggested phase deadline | Initial UX target | Completion condition and progress |
| --- | --- | --- | --- |
| Builder VM creation | 300 s; provider request deadline 90 s | Command-ready / first command within 10 s when capacity is available | Show allocation/restoration; run the actual bootstrap readiness check before entering build execution. |
| Template stop | 180 s initially; reconcile provider state after timeout | Allow about 45–60 s for saving/stopping this image; flag unusually slow at 90 s | Keep “Saving computer” visible until `archived` and a saved snapshot are confirmed. Publish the stopped template only then. |
| Workspace fork | 300 s; provider request deadline 90 s | First minimal command within 10 s for a stopped template, including a batch of 3 | Show allocation, restoration and runtime admission separately; command-ready precedes completed admission. |
| Wake | 300 s; provider request deadline 90 s | First minimal command within 10 s | Preserve the same sandbox identity; resume, check real bootstrap readiness, then admit the pinned runtime. |
| Runtime install | 600 s overall; 30 s connection/read-inactivity deadline with a separately bounded download stage | With gzip-like costs target 45–90 s; an xz-like 1 GiB archive can need roughly 3 min | Show actual download bytes, verification, unpacking and admission stages; publish ready after all required checks. |
| Named snapshot save (optional comparison) | 300 s initially | About 60 s for this existing base and tiny changed-data fork | Poll `saving` → `ready`; never substitute POST acceptance for completion. |

All startup command HTTP deadlines should exceed Boat's documented 60 s startup wait; 90 s provides room for transport overhead. A lifecycle/command deadline should trigger state reconciliation and retain the owned ID, rather than dispatching an independent start. Actual build-script timeouts need a separate workload budget.

The two stops dominate the measured provider boundary. A fresh build that also downloads/adopts a 1 GiB gzip-like runtime can already approach 80 s from the observed create + inferred install + observed stop costs, before repository checkout or setup scripts. Do not promise a complete org build in under 30 s from these VM-start numbers.

## Observed states, HTTP codes and anomalies

The Boat request journal contains 375 scoped requests: {'200': 326, '202': 18, '404': 31}. HTTP 404s are expected absent/deleted-resource checks. There were no Boat 409 `boat_starting`, `cancelled`, 402, 429, 5xx, or transport failures. All eight start POSTs returned 202; all first `true` executions returned 200 / exit 0 on their first attempt. The shared start caps were 12/minute, 60/hour and 200/day.

An initial public Alpha identity request with Python's default user agent returned HTTP 403; repeating that public request with an explicit browser-like user agent returned 200. This was an Alpha endpoint observation, not a Boat refusal. The exact requested first tree scan failed for permissions and a transient lazy-filesystem filename, as documented above. The first supplementary driver invocation found that its intended fork was already deleted and exited locally with `StopIteration`; it made no API request or start. The retained final driver then allocated one additional owned download VM.

The one optional named snapshot, `zeros-v2-test-snap`, was saved from existing fork `bx_rgtefmyh`: a default-size fork with only small changes to the inherited base, not a separate `small` machine type. It reported 6,946,291,712 bytes and transitioned `saving` → `ready` in 47.077 s. DELETE was issued immediately after readiness and returned HTTP 200; GET returned 404 within about 0.9 s of observing readiness. No other named snapshot was saved or removed.

## Cleanup confirmation

Final audit: **7/7 created sandbox IDs GET 404**, test named snapshot GET 404, billing-org active sandbox count 0, eight start dispatches, no tracked diff, branch still `main`. DELETEs were accepted with HTTP 202 and independently rechecked after deleting the complete test family. The Alpha base named snapshot remains ready and its reported size is unchanged.

| Name | Sandbox ID | DELETE | Final GET | Deletion operation | Latest status/stage | Expected fence end UTC |
| --- | --- | ---: | ---: | --- | --- | --- |
| zeros-v2-test-template-1 | bx_x6m3hs5m | 202 | 404 | bdop_4b840ab561ea421188a2c86782b3a982 | blocked/waiting_for_uploads | 2026-10-04T10:48:11.527Z |
| zeros-v2-test-template-2 | bx_v65f7pa8 | 202 | 404 | bdop_a441acc281a147c981801be86f26cb2b | blocked/waiting_for_uploads | 2026-10-04T15:47:03.327Z |
| zeros-v2-test-fork-1 | bx_rgtefmyh | 202 | 404 | bdop_975ca578fb0744f9878b54d7b157863d | blocked/waiting_for_uploads | 2026-10-04T15:47:59.646Z |
| zeros-v2-test-fork-3 | bx_8vsyknjn | 202 | 404 | bdop_a5cede59d68544cca2ad2775fb5dd4b4 | blocked/waiting_for_uploads | 2026-10-04T15:47:50.968Z |
| zeros-v2-test-fork-2 | bx_vtcpyu3p | 202 | 404 | bdop_140401c7250946149c2f52cda422777f | blocked/waiting_for_uploads | 2026-10-04T15:47:57.311Z |
| zeros-v2-test-fork-4 | bx_epe6xfz8 | 202 | 404 | bdop_62656987a5c044389f26c736fdb8801e | blocked/waiting_for_uploads | 2026-10-04T15:48:14.921Z |
| zeros-v2-test-download-1 | bx_tn8pabn5 | 202 | 404 | bdop_834487c649504845ab2378d9d5d4bf52 | blocked/waiting_for_uploads | 2026-10-04T10:54:31.802Z |

These receipt states are the latest observations after bounded follow-up polling. Every receipt has `completedAt=null`. Logical resource removal and stopped compute are confirmed by GET 404 and org active-count 0; **physical byte erasure is not yet confirmed**. Boat reports `waiting_for_uploads` fences with the UTC times above. Its [retention documentation](https://docs.boat.dev/data-retention) describes delayed physical deletion and shared snapshot objects. Snapshot-name deletion likewise confirms removal of the test restore artifact, not immediate physical erase of deduplicated objects.

## Verification and scope

| Command | Result | Seconds | Evidence |
| --- | --- | ---: | --- |
| `pnpm agent:check --file /dev/stdin` | PASS | 1.238 | [check-agent-check.log](/home/vercel-sandbox/zeros/.context/impl/boat-timings/check-agent-check.log) |
| `pnpm typecheck` | PASS | 72.918 | [check-typecheck.log](/home/vercel-sandbox/zeros/.context/impl/boat-timings/check-typecheck.log) |
| `pnpm lint` | PASS | 35.442 | [check-lint.log](/home/vercel-sandbox/zeros/.context/impl/boat-timings/check-lint.log) |
| `pnpm check:ui` | PASS | 2.771 | [check-check-ui.log](/home/vercel-sandbox/zeros/.context/impl/boat-timings/check-check-ui.log) |
| `pnpm test:git` | FAIL, exit 1 | 269.667 | [check-test-git.log](/home/vercel-sandbox/zeros/.context/impl/boat-timings/check-test-git.log) |
| `pnpm check:secrets` | PASS | 10.012 | [check-check-secrets.log](/home/vercel-sandbox/zeros/.context/impl/boat-timings/check-check-secrets.log) |

The Boat-only credential check ran the original `pnpm agent:check` CLI with only the two Boat variables supplied privately on stdin from `.env.agent`. The preload delegates its HTTP call to Python `urllib`, pins the Boat origin, and adds `X-Boat-Org`. Other provider APIs were not contacted; inherited Claude/Cursor values were marked present but not probed by that CLI.

`pnpm test:git` reported 1308 passing / 10 failing / 3 skipped files and 13,863 passing / 40 failing / 55 skipped tests. All reported failure classes were missing Playwright Chromium headless shell build 1217, unavailable absolute `bwrap`, or missing `socat`. No tracked source was changed to address these unrelated VM prerequisites. Python syntax compilation passed for the measurement, VM probes, transport helper and check driver. macOS-only engine/UI checks were not run in this Linux cloud VM; there was no implementation change requiring those targeted gates.

No tracked files were edited, staged or committed; no branch was renamed and no PR was opened. All local scripts, logs and reports are under this gitignored directory. No Beta/Production API or settings were used.

The final private-artifact audit also passed: no credential values or token-shaped values were detected, no mutation paths targeted resources outside the owned ledger, and Git status remained clean. Evidence: [artifact-verification.json](/home/vercel-sandbox/zeros/.context/impl/boat-timings/artifact-verification.json); exact audit script: [verify_artifacts.py](/home/vercel-sandbox/zeros/.context/impl/boat-timings/verify_artifacts.py). The report generator is [render_report.py](/home/vercel-sandbox/zeros/.context/impl/boat-timings/render_report.py).

## Follow-ups (out of scope)

- Repeat the chosen v4 runtime archive's complete signature/manifest/install/admission path on the actual artifact store and codec, with controlled cold-cache sampling and more than one size.
- Measure stop/save after a real multi-repository org build and larger batches of concurrent forks; these samples cannot establish p95 or an availability SLA.
- Confirm physical deletion receipts after the recorded upload fences; the requested DELETE + GET cleanup checks have completed.
- Resolve the existing runtime-tree permission and hydration-scratch behavior when defining an exact deployed-file manifest; the privileged measurement did not change any file permissions.
- Restore local browser, bubblewrap and socat test prerequisites before using the full Vitest baseline as a green release gate.

## Exact executed scripts and commands

The complete script contents are included below, without credential values. The initial failed-run versions are retained verbatim as [run-1-boat_measure.py](/home/vercel-sandbox/zeros/.context/impl/boat-timings/run-1-boat_measure.py) and [run-1-vm_probe.py](/home/vercel-sandbox/zeros/.context/impl/boat-timings/run-1-vm_probe.py); the prior check driver is [run-1-run_checks.py](/home/vercel-sandbox/zeros/.context/impl/boat-timings/run-1-run_checks.py). The locally failed supplementary-driver version is [download_xz-first-attempt.py](/home/vercel-sandbox/zeros/.context/impl/boat-timings/download_xz-first-attempt.py). The final lifecycle harness preserves the first run's ledger and cumulative budget when repeating the experiment.

Commands executed from `/home/vercel-sandbox/zeros`:

```text
python3 -m py_compile .context/impl/boat-timings/boat_measure.py .context/impl/boat-timings/vm_probe.py
python3 .context/impl/boat-timings/boat_measure.py preflight
python3 .context/impl/boat-timings/boat_measure.py measure
python3 .context/impl/boat-timings/run_checks.py
python3 .context/impl/boat-timings/boat_measure.py measure
python3 .context/impl/boat-timings/download_xz.py
python3 .context/impl/boat-timings/download_xz.py
python3 -m py_compile .context/impl/boat-timings/boat_measure.py .context/impl/boat-timings/vm_probe.py .context/impl/boat-timings/download_xz.py .context/impl/boat-timings/vm_probe_xz.py .context/impl/boat-timings/run_checks.py .context/impl/boat-timings/urllib_bridge.py
python3 .context/impl/boat-timings/final_audit.py
python3 .context/impl/boat-timings/render_report.py
python3 .context/impl/boat-timings/verify_artifacts.py
git status --short
git diff --stat
```

The two `measure` invocations and two supplementary-driver invocations reflect the documented failed/repeated probes. Each measurement script contains its cleanup path; no extra cleanup start was needed. The Node archive source is transported as plain Python through Boat's synchronous command API.

Published API contract references: [OpenAPI](https://docs.boat.dev/openapi/boat-v1.yaml), [fork](https://docs.boat.dev/api/reference/sandboxes/fork-sandbox), [stop](https://docs.boat.dev/api/reference/sandboxes/stop-and-archive-sandbox), [startup command behavior](https://docs.boat.dev/api/reference/agent/execute-sandbox-command), [snapshots](https://docs.boat.dev/snapshots). Local cached sources: `/home/vercel-sandbox/zeros/.context/research/r3/`.

<details>
<summary>boat_measure.py — complete source</summary>

```python
#!/usr/bin/env python3
"""Bounded Boat-only lifecycle experiment. All local outputs stay beside this file.

Usage: python3 .context/impl/boat-timings/boat_measure.py preflight|measure|cleanup
No credentials are accepted in command arguments or stored in experiment evidence.
"""
import concurrent.futures
import datetime
import json
import pathlib
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

DIRECTORY = pathlib.Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[2]
API_BASE = 'https://boat.dev/api/v1'
ALPHA_IDENTITY = 'https://api-alpha.zeros.build/v1/release-identity'
RESOURCE_PATTERN = re.compile(r'^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$')
START_CAP = 10
READY_TIMEOUT = 300
STOP_TIMEOUT = 600
SNAPSHOT_TIMEOUT = 600
POLL_SECONDS = 1
TTL_SECONDS = 1800
SNAPSHOT_NAME = 'zeros-v2-test-snap'
LOCK = threading.RLock()
STATE = {}


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def read_env():
    values = {}
    for line in (ROOT / '.env.agent').read_text().splitlines():
        match = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', line.strip())
        if not match:
            continue
        value = match[2].strip()
        if len(value) >= 2 and value[0] in '\"\'' and value[-1] == value[0]:
            value = value[1:-1]
        if match[1] in values:
            raise RuntimeError('Duplicate environment variable: ' + match[1])
        values[match[1]] = value
    for name in ['BOAT_API_KEY', 'BOAT_BILLING_ORG']:
        if not values.get(name):
            raise RuntimeError('Missing environment variable: ' + name)
    return values


ENV = read_env()


def safe_text(text):
    for value in ENV.values():
        if len(value) >= 8:
            text = text.replace(value, '[REDACTED]')
    text = re.sub(r'(?i)\b(?:C_URL|C_URL)\b', 'C_URL', text)
    text = re.sub(r'\b(?:ghs_|gho_|ghp_|ghu_|github_pat_|condw_|sk_|sk-)[A-Za-z0-9_-]+', '[TOKEN]', text)
    text = re.sub(r'\bboat_[A-Za-z0-9_-]{32,}', '[TOKEN]', text)
    text = re.sub(r'Bearer\s+[^\s\"\']+', '[AUTHORIZATION]', text, flags=re.I)
    text = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[JWT]', text)
    text = re.sub(r'(?<![A-Za-z0-9_])[a-fA-F0-9]{40,}(?![A-Za-z0-9_])', '[DIGEST]', text)
    return text


def safe_value(value):
    return json.loads(safe_text(json.dumps(value, ensure_ascii=True)))


def write_json(name, data):
    (DIRECTORY / name).write_text(json.dumps(safe_value(data), indent=2, sort_keys=True) + '\n')


def persist():
    with LOCK:
        write_json('results.json', STATE)


def notice(event, **values):
    row = safe_value({'at': timestamp(), 'event': event, **values})
    with LOCK:
        print(json.dumps(row, sort_keys=True), flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ApiFailure(RuntimeError):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__('HTTP ' + str(status) + ': ' + str(code))


class BoatApi:
    def request(self, method, path, body=None, timeout=90, key=None, confirm=None):
        if not path.startswith('/') or path.startswith('//') or '..' in path:
            raise RuntimeError('Invalid provider path')
        headers = {'Authorization': 'Bearer ' + ENV['BOAT_API_KEY'],
                   'X-Boat-Org': ENV['BOAT_BILLING_ORG'],
                   'Accept': 'application/json', 'User-Agent': 'zeros-v2-test-measurement'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        if key:
            headers['Idempotency-Key'] = key
        if confirm:
            headers['X-Ascii-Confirm-Delete'] = confirm
        req = urllib.request.Request(API_BASE + path, method=method, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
        began = time.perf_counter()
        started_at = timestamp()
        network_error = None
        try:
            try:
                response = urllib.request.build_opener(NoRedirect()).open(req, timeout=timeout)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.code
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise RuntimeError('Provider response exceeded the bounded read')
                try:
                    data = json.loads(raw)
                except ValueError:
                    data = {}
                retry_after = response.headers.get('Retry-After')
        except Exception as error:
            status, data, retry_after = 0, {}, None
            network_error = type(error).__name__
        elapsed = time.perf_counter() - began
        sandbox = data.get('sandbox') if isinstance(data.get('sandbox'), dict) else {}
        operation = data.get('operation') if isinstance(data.get('operation'), dict) else {}
        snapshot = data.get('snapshot') if isinstance(data.get('snapshot'), dict) else {}
        event = {'at': started_at, 'method': method, 'path': path, 'http': status,
                 'seconds': elapsed, 'billing_org_header_sent': True,
                 'response_type': data.get('type'), 'code': data.get('code'),
                 'response_status': data.get('status'), 'state': sandbox.get('state'),
                 'resource_id': sandbox.get('id', data.get('id')),
                 'snapshot_status': snapshot.get('status'),
                 'operation': {k: operation.get(k) for k in
                               ['id', 'kind', 'targetId', 'status', 'stage', 'expectedBy',
                                'requestedAt', 'completedAt', 'attemptCount']},
                 'retry_after': retry_after, 'network_error': network_error}
        with LOCK:
            with (DIRECTORY / 'http-events.jsonl').open('a') as out:
                out.write(json.dumps(safe_value(event), sort_keys=True) + '\n')
        return status, data, elapsed


API = BoatApi()


def summary_sandbox(row):
    result = {k: row.get(k) for k in ['id', 'state', 'type', 'vcpu', 'memoryGB',
              'machineProvider', 'snapshotAvailable', 'snapshots', 'health',
              'snapshotCompletedAt', 'snapshotVerifiedAt', 'lastSnapshotStatus']}
    result['billing_org_matches'] = isinstance(row.get('team'), dict) and row['team'].get('id') == ENV['BOAT_BILLING_ORG']
    return result


def preflight():
    result = {'at': timestamp(), 'credentials_present': ['BOAT_API_KEY', 'BOAT_BILLING_ORG'],
              'api_base': API_BASE, 'start_cap': START_CAP, 'machine_type': 'default',
              'ttl_seconds': TTL_SECONDS, 'alpha_identity_url': ALPHA_IDENTITY}
    request = urllib.request.Request(ALPHA_IDENTITY, headers={
        'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 zeros-v2-test-measurement'})
    try:
        try:
            response = urllib.request.build_opener(NoRedirect()).open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result['alpha_identity_http'] = response.code
            identity = json.loads(response.read(1024 * 1024))
        result['alpha_identity_response_keys'] = sorted(identity) if isinstance(identity, dict) else []
        result['alpha_identity_error_code'] = identity.get('code', identity.get('error'))
        result['alpha_channel'] = identity.get('channel')
        worker = identity.get('worker') or {}
        match = re.fullmatch(r'boat:([a-z0-9][a-z0-9-]{0,62})@sha256:[a-f0-9]{64}', worker.get('imageRef', ''))
        if identity.get('channel') != 'alpha':
            raise RuntimeError('Public identity did not identify Alpha')
        result['configured_snapshot'] = match[1] if match and worker.get('provider') == 'boat' else None
        result['worker'] = {'provider': worker.get('provider'), 'architecture': worker.get('architecture'),
                            'storageMiB': worker.get('storageMiB'), 'sourceShaShort': str(worker.get('sourceSha', ''))[:12],
                            'workerQualified': identity.get('workerQualified'), 'releaseReady': identity.get('ready')}
    except Exception as error:
        result['alpha_identity_error'] = type(error).__name__
        result['configured_snapshot'] = None
    status, data, _ = API.request('GET', '/limits')
    result['limits_http'] = status
    numeric_or_bool = lambda x: isinstance(x, (int, float, bool)) or x is None
    def limit_fields(obj):
        if not isinstance(obj, dict):
            return {}
        allowed = ['activeSandboxes', 'maxActiveSandboxes', 'canStart', 'canCreate',
                   'creationRatePerMinute', 'creationRequestsPerHour', 'creationRequestsPerDay',
                   'maxCreationRequestsPerMinute', 'maxCreationRequestsPerDay',
                   'startsPerMinute', 'startsPerHour', 'startsPerDay', 'startLimits', 'starts',
                   'currentLimits', 'perMinute', 'perHour', 'perDay', 'remaining', 'used', 'limit',
                   'minute', 'hour', 'day', 'allowed', 'windowSeconds', 'count', 'nextAvailableAt']
        out = {}
        for k, v in obj.items():
            if k not in allowed:
                continue
            if isinstance(v, dict):
                out[k] = limit_fields(v)
            elif numeric_or_bool(v):
                out[k] = v
        return out
    result['limits'] = limit_fields(data)
    if result['configured_snapshot']:
        status, data, _ = API.request('GET', '/named-snapshots/' + result['configured_snapshot'])
        row = data.get('snapshot') or {}
        result['configured_snapshot_http'] = status
        result['configured_snapshot_status'] = row.get('status')
        result['configured_snapshot_size_bytes'] = row.get('sizeBytes')
    result['tracked_status_initial'] = __import__('subprocess').check_output(
        ['git', 'status', '--short'], cwd=ROOT, text=True)
    result['branch_initial'] = __import__('subprocess').check_output(
        ['git', 'branch', '--show-current'], cwd=ROOT, text=True).strip()
    write_json('preflight.json', result)
    notice('preflight', **result)
    return result


def reserve_start(purpose):
    with LOCK:
        count = len(STATE['start_attempts'])
        if count >= START_CAP:
            raise RuntimeError('Ten-start budget exhausted')
        row = {'number': count + 1, 'purpose': purpose, 'at': timestamp()}
        STATE['start_attempts'].append(row)
        persist()


def metric(label, seconds, **details):
    with LOCK:
        STATE['metrics'].append({'measurement': label, 'value': seconds, 'unit': 's', **details})
        persist()


def trace_state(operation, started, row):
    state = row.get('state')
    trace = operation['states']
    if not trace or trace[-1]['state'] != state:
        trace.append({'seconds': time.perf_counter() - started, 'state': state})
        notice('state', purpose=operation['purpose'], resource_id=row.get('id'), state=state)


def require(status, data, accepted=(200, 202)):
    if status not in accepted or data.get('ok') is False:
        raise ApiFailure(status, data.get('code', 'unknown'))


def wait_state(resource_id, operation, began, target_states, timeout, initial=None):
    deadline = began + timeout
    row = initial or {}
    if row.get('state'):
        trace_state(operation, began, row)
        if row['state'] in target_states:
            return row
    while time.perf_counter() < deadline:
        status, data, _ = API.request('GET', '/sandboxes/' + resource_id, timeout=30)
        require(status, data, (200,))
        row = data.get('sandbox') or {}
        trace_state(operation, began, row)
        persist()
        if row.get('state') in target_states:
            return row
        if row.get('state') in ('error', 'cancelled'):
            raise RuntimeError('Terminal sandbox state: ' + row['state'])
        time.sleep(POLL_SECONDS)
    raise TimeoutError('State polling reached ' + str(timeout) + ' seconds')


def first_exec(resource_id, operation, began):
    deadline = began + READY_TIMEOUT + 90
    while time.perf_counter() < deadline:
        status, data, elapsed = API.request('POST', '/sandboxes/' + resource_id + '/commands',
                                          {'command': 'true', 'timeoutSeconds': 30})
        operation.setdefault('first_exec_attempts', []).append(
            {'http': status, 'seconds': elapsed, 'code': data.get('code'),
             'exit_code': data.get('exitCode'), 'timed_out': data.get('timedOut')})
        if status == 200 and data.get('exitCode') == 0 and not data.get('timedOut'):
            return time.perf_counter() - began
        if status == 409 and data.get('code') in ('boat_starting', 'boat_restoring'):
            time.sleep(POLL_SECONDS)
            continue
        require(status, data, (200,))
        raise RuntimeError('First exec failed')
    raise TimeoutError('No successful first exec before deadline')


def launch(purpose, endpoint, body, name=None, known_id=None):
    reserve_start(purpose)
    operation = {'purpose': purpose, 'endpoint': endpoint, 'states': [], 'name': name, 'at': timestamp()}
    with LOCK:
        STATE['operations'].append(operation)
    key = None if known_id else 'zeros-v2-test-' + uuid.uuid4().hex
    began = time.perf_counter()
    notice('start_requested', purpose=purpose, name=name)
    status, data, elapsed = API.request('POST', endpoint, body, key=key)
    operation.update({'accept_http': status, 'accept_seconds': elapsed, 'accept_code': data.get('code')})
    row = data.get('sandbox') or {}
    resource_id = known_id or row.get('id') or data.get('id')
    if status == 0 and known_id is None:
        reserve_start(purpose + '-idempotent-recovery')
        status, data, elapsed = API.request('POST', endpoint, body, key=key)
        row = data.get('sandbox') or {}
        resource_id = row.get('id') or data.get('id')
        operation['recovery_http'] = status
    if resource_id and RESOURCE_PATTERN.fullmatch(resource_id):
        operation['resource_id'] = resource_id
        if not known_id:
            with LOCK:
                STATE['resources'][resource_id] = {'id': resource_id, 'name': name, 'purpose': purpose,
                    'deleted': False, 'created_at': timestamp(), 'rename_http': None}
                persist()
    require(status, data)
    if not resource_id or not RESOURCE_PATTERN.fullmatch(resource_id):
        raise RuntimeError('No validated sandbox id in allocation response')
    if name:
        named_status, named_data, _ = API.request('PATCH', '/sandboxes/' + resource_id, {'name': name})
        STATE['resources'][resource_id]['rename_http'] = named_status
        require(named_status, named_data, (200,))
    ready = wait_state(resource_id, operation, began, {'ready', 'idle', 'running'}, READY_TIMEOUT, row)
    operation['ready_seconds'] = time.perf_counter() - began
    operation['ready'] = summary_sandbox(ready)
    if operation['ready']['billing_org_matches'] is not True:
        # If the initial response omitted team, read the full sandbox before proceeding.
        stat, current, _ = API.request('GET', '/sandboxes/' + resource_id)
        require(stat, current, (200,))
        operation['ready'] = summary_sandbox(current.get('sandbox') or {})
        if operation['ready']['billing_org_matches'] is not True:
            raise RuntimeError('Allocated sandbox did not confirm configured billing org')
    operation['first_exec_seconds'] = first_exec(resource_id, operation, began)
    metric(purpose + ': request to ready', operation['ready_seconds'], resource_id=resource_id)
    metric(purpose + ': request to first successful exec', operation['first_exec_seconds'], resource_id=resource_id)
    persist()
    notice('start_measured', purpose=purpose, resource_id=resource_id,
           ready_seconds=operation['ready_seconds'], first_exec_seconds=operation['first_exec_seconds'])
    return resource_id


def probe(resource_id, mode, tree=None, timeout=600):
    source = (DIRECTORY / 'vm_probe.py').read_text()
    command = "python3 - <<'ZEROS_V2_PROBE'\nMODE = " + repr(mode) + '\nTREE = ' + repr(tree) + '\n' + source + '\nZEROS_V2_PROBE'
    notice('probe_requested', mode=mode, resource_id=resource_id)
    status, data, elapsed = API.request('POST', '/sandboxes/' + resource_id + '/commands',
                                      {'command': command, 'timeoutSeconds': timeout}, timeout=timeout + 90)
    require(status, data, (200,))
    if data.get('exitCode') != 0 or data.get('timedOut') or data.get('stdoutTruncated'):
        raise RuntimeError('VM probe failed: ' + mode + '; exit=' + str(data.get('exitCode')))
    result = json.loads(data['stdout'])
    result['command_api_wall_seconds'] = elapsed
    result['command_api_http'] = status
    return result


def stop(resource_id, index):
    operation = {'purpose': 'stop-' + str(index), 'resource_id': resource_id, 'states': [], 'at': timestamp()}
    STATE['operations'].append(operation)
    began = time.perf_counter()
    notice('stop_requested', index=index, resource_id=resource_id)
    status, data, elapsed = API.request('POST', '/sandboxes/' + resource_id + '/stop', {})
    operation.update({'accept_http': status, 'accept_seconds': elapsed, 'accept_code': data.get('code')})
    require(status, data)
    row = wait_state(resource_id, operation, began, {'archived', 'stopped'}, STOP_TIMEOUT,
                     data.get('sandbox'))
    operation['stopped_seconds'] = time.perf_counter() - began
    operation['stopped'] = summary_sandbox(row)
    if row.get('snapshotAvailable') is not True:
        raise RuntimeError('Stopped sandbox did not confirm a saved snapshot')
    metric('template stop: request to archived', operation['stopped_seconds'], iteration=index)
    persist()
    notice('stop_measured', index=index, seconds=operation['stopped_seconds'], state=row.get('state'))


def delete_resource(resource_id):
    if resource_id not in STATE['resources']:
        raise RuntimeError('Refusing to delete an unowned resource')
    row = STATE['resources'][resource_id]
    began = time.perf_counter()
    status, data, elapsed = API.request('DELETE', '/sandboxes/' + resource_id, confirm=resource_id)
    row['delete_http'] = status
    row['delete_accept_seconds'] = elapsed
    op = data.get('operation') or {}
    row['deletion_operation'] = {k: op.get(k) for k in ['id', 'kind', 'targetId', 'status', 'stage', 'expectedBy', 'completedAt']}
    persist()
    require(status, data, (202, 404))
    check_status, check_data, _ = API.request('GET', '/sandboxes/' + resource_id)
    row['final_get_http'] = check_status
    row['deleted'] = check_status == 404
    row['delete_to_get_404_seconds'] = time.perf_counter() - began if row['deleted'] else None
    if row['deleted']:
        metric('sandbox delete: request to GET 404', row['delete_to_get_404_seconds'], resource_id=resource_id)
    if op.get('id'):
        receipt_status, receipt, _ = API.request('GET', '/deletion-operations/' + op['id'])
        current = receipt.get('operation') or {}
        row['deletion_receipt_http'] = receipt_status
        row['deletion_operation_latest'] = {k: current.get(k) for k in ['id', 'status', 'stage', 'expectedBy', 'completedAt', 'attemptCount']}
    persist()
    notice('sandbox_deleted', resource_id=resource_id, delete_http=status,
           verification_http=check_status, receipt=row.get('deletion_operation_latest'))
    if not row['deleted']:
        raise RuntimeError('Sandbox deletion not confirmed by GET 404')


def delete_snapshot():
    info = STATE.get('named_snapshot')
    if not info or not info.get('ownership_intent') or info.get('deleted'):
        return
    status, data, _ = API.request('GET', '/named-snapshots/' + SNAPSHOT_NAME)
    if status == 404:
        info.update({'deleted': True, 'final_get_http': 404})
        persist()
        return
    require(status, data, (200,))
    row = data.get('snapshot') or {}
    if row.get('sourceSandboxId') != info['source_sandbox_id']:
        raise RuntimeError('Snapshot source does not match the experiment; will not delete')
    status, data, _ = API.request('DELETE', '/named-snapshots/' + SNAPSHOT_NAME)
    info['delete_http'] = status
    require(status, data, (200, 202, 404))
    check_status, _, _ = API.request('GET', '/named-snapshots/' + SNAPSHOT_NAME)
    info.update({'deleted': check_status == 404, 'final_get_http': check_status, 'deleted_at': timestamp()})
    persist()
    notice('named_snapshot_deleted', name=SNAPSHOT_NAME, delete_http=status, verification_http=check_status)
    if not info['deleted']:
        raise RuntimeError('Named snapshot deletion was not confirmed')


def save_optional_snapshot(resource_id):
    status, data, _ = API.request('GET', '/named-snapshots/' + SNAPSHOT_NAME)
    if status != 404:
        STATE['snapshot_skipped'] = 'Name was not confirmed absent; no overwrite attempted'
        persist()
        return
    info = {'name': SNAPSHOT_NAME, 'source_sandbox_id': resource_id,
            'ownership_intent': True, 'states': [], 'at': timestamp(), 'deleted': False}
    STATE['named_snapshot'] = info
    persist()
    began = time.perf_counter()
    notice('named_snapshot_save_requested', name=SNAPSHOT_NAME, resource_id=resource_id)
    try:
        status, data, elapsed = API.request('POST', '/named-snapshots', {'sandboxId': resource_id, 'name': SNAPSHOT_NAME})
        info.update({'save_http': status, 'accept_seconds': elapsed, 'code': data.get('code')})
        require(status, data)
        snapshot = data.get('snapshot') or {}
        deadline = began + SNAPSHOT_TIMEOUT
        while True:
            current_status = snapshot.get('status')
            if not info['states'] or info['states'][-1]['status'] != current_status:
                info['states'].append({'seconds': time.perf_counter() - began, 'status': current_status})
                notice('named_snapshot_state', status=current_status)
                persist()
            if current_status == 'ready':
                info['ready_seconds'] = time.perf_counter() - began
                info['size_bytes'] = snapshot.get('sizeBytes')
                metric('named snapshot save: request to ready', info['ready_seconds'])
                return
            if current_status == 'failed':
                raise RuntimeError('Optional snapshot failed')
            if time.perf_counter() >= deadline:
                raise TimeoutError('Optional snapshot deadline elapsed')
            time.sleep(POLL_SECONDS)
            status, data, _ = API.request('GET', '/named-snapshots/' + SNAPSHOT_NAME, timeout=30)
            require(status, data, (200,))
            snapshot = data.get('snapshot') or {}
    except Exception as error:
        info['error'] = type(error).__name__ + ': ' + str(error)
        notice('optional_snapshot_error', error=info['error'])
    finally:
        delete_snapshot()


def cleanup():
    errors = []
    try:
        delete_snapshot()
    except Exception as error:
        errors.append('snapshot: ' + type(error).__name__ + ': ' + str(error))
    for resource_id, row in list(STATE.get('resources', {}).items()):
        if row.get('deleted'):
            continue
        try:
            delete_resource(resource_id)
        except Exception as error:
            errors.append(resource_id + ': ' + type(error).__name__ + ': ' + str(error))
    # Re-query every created id after deleting the entire family, not only just after DELETE.
    for resource_id, row in list(STATE.get('resources', {}).items()):
        status, _, _ = API.request('GET', '/sandboxes/' + resource_id)
        row['final_get_http'] = status
        row['deleted'] = status == 404
    # Observe physical deletion receipts for a bounded additional minute.
    deadline = time.perf_counter() + 60
    while True:
        pending = False
        for row in STATE.get('resources', {}).values():
            operation_id = (row.get('deletion_operation') or {}).get('id')
            if not operation_id:
                continue
            status, data, _ = API.request('GET', '/deletion-operations/' + operation_id, timeout=20)
            current = data.get('operation') or {}
            row['deletion_receipt_http'] = status
            row['deletion_operation_latest'] = {k: current.get(k) for k in ['id', 'status', 'stage', 'expectedBy', 'completedAt', 'attemptCount']}
            if current.get('status') != 'completed':
                pending = True
        persist()
        if not pending or time.perf_counter() >= deadline:
            break
        time.sleep(5)
    STATE['cleanup_errors'] = errors
    STATE['cleanup_at'] = timestamp()
    STATE['all_sandboxes_get_404'] = all(row.get('deleted') for row in STATE.get('resources', {}).values())
    STATE['named_snapshot_deleted_or_not_created'] = not STATE.get('named_snapshot') or STATE['named_snapshot'].get('deleted', False)
    persist()
    notice('cleanup_complete', all_sandboxes_get_404=STATE['all_sandboxes_get_404'],
           sandbox_count=len(STATE.get('resources', {})), errors=errors)


def measure():
    global STATE
    previous = None
    if (DIRECTORY / 'results.json').exists():
        previous = json.loads((DIRECTORY / 'results.json').read_text())
        if previous.get('measurements_completed') or not previous.get('measurement_error'):
            raise RuntimeError('Only an incomplete, failed run may be repeated')
        if not previous.get('all_sandboxes_get_404') or not previous.get('named_snapshot_deleted_or_not_created'):
            raise RuntimeError('Prior run must be cleaned up before another start')
        if START_CAP - len(previous['start_attempts']) < 6:
            raise RuntimeError('The remaining start budget cannot cover the complete lifecycle')
        write_json('run-1-results.json', previous)
    initial = preflight()
    STATE = {'started_at': timestamp(), 'preflight': initial, 'start_attempts': [],
             'resources': {}, 'operations': [], 'metrics': []}
    if previous:
        STATE.update({'started_at': previous['started_at'], 'retry_started_at': timestamp(),
                      'prior_incomplete_run': 'run-1-results.json',
                      'start_attempts': previous['start_attempts'],
                      'resources': previous['resources'], 'operations': previous['operations'],
                      'metrics': previous['metrics']})
    persist()
    try:
        body = {'type': 'default', 'ttlSeconds': TTL_SECONDS, 'noEnv': True, 'env': {}, 'snapshots': True}
        if initial.get('configured_snapshot'):
            body['from'] = initial['configured_snapshot']
        try:
            name = 'zeros-v2-test-template-' + str(len(STATE['start_attempts']) + 1)
            template = launch('create', '/sandboxes', body, name)
            STATE['used_snapshot'] = body.get('from', 'Boat default image')
        except ApiFailure as error:
            if 'from' not in body or error.status not in (400, 403, 404):
                raise
            STATE['base_snapshot_fallback_reason'] = str(error)
            body.pop('from')
            template = launch('create-default-fallback', '/sandboxes', body, 'zeros-v2-test-template-2')
            STATE['used_snapshot'] = 'Boat default image'
        STATE['template_id'] = template
        STATE['vm_facts'] = probe(template, 'facts', timeout=120)
        persist()
        tree = STATE['vm_facts']['tree']['path']
        for label in ['cold', 'warm']:
            result = probe(template, label, tree)
            STATE[label + '_tree_read'] = result
            if result['exit_code'] != 0:
                raise RuntimeError('Tree hash pipeline failed: ' + label)
            metric('runtime tree checksum: ' + label + ' pass', result['seconds'])
            notice('tree_read_measured', cache=label, seconds=result['seconds'], tree=tree)
        STATE['download_probe'] = probe(template, 'download', timeout=600)
        download = STATE['download_probe']
        for name, key in [('public archive download', 'download_seconds'),
                          ('downloaded archive sha256sum', 'sha256sum_seconds'),
                          ('downloaded archive extraction', 'extraction_seconds')]:
            metric(name, download[key])
        STATE['metrics'].append({'measurement': 'public archive download throughput',
                                 'value': download['download_mib_per_second'], 'unit': 'MiB/s'})
        persist()
        stop(template, 1)
        launch('resume', '/sandboxes/' + template + '/resume',
               {'ttlSeconds': TTL_SECONDS, 'noEnv': True, 'env': {}}, known_id=template)
        STATE['resume_marker_check'] = probe(template, 'marker', timeout=30)
        if not STATE['resume_marker_check']['marker_matches']:
            raise RuntimeError('Marker missing after resume')
        stop(template, 2)
        fork_body = {'type': 'default', 'ttlSeconds': TTL_SECONDS, 'noEnv': True, 'env': {}}
        first = launch('fork-serial', '/sandboxes/' + template + '/fork', fork_body, 'zeros-v2-test-fork-1')
        STATE['fork_marker_checks'] = {first: probe(first, 'marker', timeout=30)}
        fork_ids = [first]
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(launch, 'fork-concurrent-' + str(n), '/sandboxes/' + template + '/fork',
                                   fork_body, 'zeros-v2-test-fork-' + str(n + 1)) for n in range(1, 4)]
            concurrent_errors = []
            for future in futures:
                try:
                    fork_ids.append(future.result())
                except Exception as error:
                    concurrent_errors.append(type(error).__name__ + ': ' + str(error))
            if concurrent_errors:
                raise RuntimeError('Concurrent fork errors: ' + '; '.join(concurrent_errors))
        for resource_id in fork_ids[1:]:
            STATE['fork_marker_checks'][resource_id] = probe(resource_id, 'marker', timeout=30)
        if not all(c['marker_matches'] for c in STATE['fork_marker_checks'].values()):
            raise RuntimeError('Marker missing from a fork')
        persist()
        delete_resource(template)
        STATE['forks_after_template_delete'] = {}
        for resource_id in fork_ids:
            status, data, elapsed = API.request('POST', '/sandboxes/' + resource_id + '/commands',
                                              {'command': 'true', 'timeoutSeconds': 30})
            require(status, data, (200,))
            marker = probe(resource_id, 'marker', timeout=30)
            STATE['forks_after_template_delete'][resource_id] = {
                'true_http': status, 'true_exit_code': data.get('exitCode'),
                'true_seconds': elapsed, **marker}
            if data.get('exitCode') != 0 or not marker['marker_matches']:
                raise RuntimeError('Fork stopped working after source deletion')
        persist()
        if len(STATE['start_attempts']) < START_CAP:
            save_optional_snapshot(first)
        STATE['measurements_completed'] = True
    except Exception as error:
        STATE['measurement_error'] = type(error).__name__ + ': ' + str(error)
        notice('measurement_error', error=STATE['measurement_error'])
    finally:
        cleanup()
        STATE['finished_at'] = timestamp()
        persist()
    return STATE.get('measurements_completed') and STATE.get('all_sandboxes_get_404') and STATE.get('named_snapshot_deleted_or_not_created')


if __name__ == '__main__':
    operation = sys.argv[1] if len(sys.argv) == 2 else ''
    if operation == 'preflight':
        preflight()
    elif operation == 'measure':
        sys.exit(0 if measure() else 1)
    elif operation == 'cleanup':
        STATE = json.loads((DIRECTORY / 'results.json').read_text())
        cleanup()
    else:
        raise SystemExit('Expected preflight, measure, or cleanup')

```

</details>

<details>
<summary>vm_probe.py — complete source</summary>

```python
"""Transported to a newly created test sandbox through Boat's commands API."""
import json
import os
import pathlib
import shlex
import shutil
import subprocess
import tempfile
import time
import urllib.request

MARKER = pathlib.Path('/home/user/zeros-v2-test-marker-1.txt')
MARKER_CONTENT = 'zeros-v2-test-persistence-marker\n'
NODE_VERSION = 'v22.20.0'
NODE_ARCHIVE = 'node-' + NODE_VERSION + '-linux-x64.tar.gz'
NODE_BASE = 'https://nodejs.org/dist/' + NODE_VERSION + '/'


def capture(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=45)
    return {'exit_code': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}


def facts():
    MARKER.write_text(MARKER_CONTENT)
    commands = {
        'nproc': ['nproc'],
        'free -m': ['free', '-m'],
        'df -h': ['df', '-h'],
        'OS release': ['cat', '/etc/os-release'],
        'kernel': ['uname', '-srmo'],
    }
    output = {label: capture(args) for label, args in commands.items()}
    limits = {}
    for p in ['/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/memory.max']:
        try:
            limits[p] = pathlib.Path(p).read_text().strip()
        except OSError:
            limits[p] = 'unavailable'
    candidates = []
    for p in ['/opt/zeros', '/usr/local/zeros-runtime', '/usr/local/zeros',
              '/opt', '/usr/local/lib/node_modules', '/usr/lib']:
        if not os.path.isdir(p):
            continue
        resolved = os.path.realpath(p)
        measured = capture(['du', '-sb', resolved])
        if measured['exit_code'] == 0:
            size = int(measured['stdout'].split()[0])
            candidates.append({'path': resolved, 'apparent_bytes': size})
    preferred = next((c for c in candidates if os.path.realpath('/opt/zeros') == c['path']
                      and c['apparent_bytes'] > 4096), None)
    chosen = preferred or max(candidates, key=lambda c: c['apparent_bytes'], default=None)
    if chosen is None:
        raise RuntimeError('No readable runtime directory for the tree probe')
    return {'commands': output, 'cgroup_limits': limits, 'tree': chosen,
            'candidates': candidates, 'marker_written': MARKER.read_text() == MARKER_CONTENT}


def hash_tree(tree):
    # Root can read the restricted browser metadata. Boat's hydration scratch files
    # are not runtime payload and can disappear between find and the checksum read.
    command = ('sudo -n find ' + shlex.quote(tree) +
               " -type f ! -name '*.ascii-dw' -print0 | sudo -n xargs -0 -r sha256sum > /dev/null")
    began = time.perf_counter()
    p = subprocess.run(['bash', '-o', 'pipefail', '-c', command],
                       capture_output=True, text=True, timeout=590)
    return {'tree': tree, 'seconds': time.perf_counter() - began,
            'exit_code': p.returncode, 'stderr': p.stderr[:1200],
            'cache_evicted': False, 'command': command}


def download_probe():
    work = pathlib.Path(tempfile.mkdtemp(prefix='zeros-v2-test-download-'))
    try:
        archive = work / NODE_ARCHIVE
        started = time.perf_counter()
        request = urllib.request.Request(NODE_BASE + NODE_ARCHIVE,
                                         headers={'User-Agent': 'zeros-v2-test-measurement'})
        total = 0
        with urllib.request.urlopen(request, timeout=120) as response, archive.open('wb') as out:
            http_status = response.status
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                out.write(block)
                total += len(block)
        download_seconds = time.perf_counter() - started
        started = time.perf_counter()
        checked = subprocess.run(['sha256sum', str(archive)], capture_output=True,
                                 text=True, timeout=60)
        checksum_seconds = time.perf_counter() - started
        if checked.returncode:
            raise RuntimeError('sha256sum failed')
        digest = checked.stdout.split()[0]
        with urllib.request.urlopen(NODE_BASE + 'SHASUMS256.txt', timeout=30) as response:
            checksums = response.read(256 * 1024).decode('utf-8')
        expected = next((line.split()[0] for line in checksums.splitlines()
                         if len(line.split()) == 2 and line.split()[1] == NODE_ARCHIVE), None)
        verified = digest == expected and expected is not None
        if not verified:
            raise RuntimeError('Public Node checksum did not match')
        extracted = work / 'extracted'
        extracted.mkdir()
        started = time.perf_counter()
        unpacked = subprocess.run(['tar', '-xzf', str(archive), '-C', str(extracted)],
                                  capture_output=True, text=True, timeout=120)
        extraction_seconds = time.perf_counter() - started
        installed_bytes = sum(p.stat().st_size for p in extracted.rglob('*')
                              if p.is_file() and not p.is_symlink())
        return {'url': NODE_BASE + NODE_ARCHIVE, 'http_status': http_status,
                'archive_bytes': total, 'download_seconds': download_seconds,
                'download_mib_per_second': total / 1048576 / download_seconds,
                'sha256sum_seconds': checksum_seconds, 'sha256sum_exit_code': checked.returncode,
                'matches_upstream_sha256': verified, 'extraction_seconds': extraction_seconds,
                'extraction_exit_code': unpacked.returncode, 'extracted_bytes': installed_bytes,
                'temporary_files_removed_before_stop': True}
    finally:
        shutil.rmtree(work)


def marker_check():
    return {'marker_present': MARKER.is_file(),
            'marker_matches': MARKER.is_file() and MARKER.read_text() == MARKER_CONTENT}


if __name__ == '__main__':
    mode = globals().get('MODE', 'facts')
    if mode == 'facts':
        result = facts()
    elif mode in ('cold', 'warm'):
        result = hash_tree(globals()['TREE'])
    elif mode == 'download':
        result = download_probe()
    elif mode == 'marker':
        result = marker_check()
    else:
        raise RuntimeError('Unknown probe mode')
    print(json.dumps(result, sort_keys=True))

```

</details>

<details>
<summary>download_xz.py — complete source</summary>

```python
#!/usr/bin/env python3
"""An additional 30-50 MB public archive sample, using an already owned live fork."""
import json
import boat_measure as boat

from boat_measure import API, DIRECTORY, require, notice, write_json

state = json.loads((DIRECTORY / 'results.json').read_text())
boat.STATE = state
resource = next((row for row in state['resources'].values()
                 if row['purpose'] == 'fork-concurrent-3' and not row['deleted']), None)
created = resource is None
if created:
    state['all_sandboxes_get_404'] = False
    body = {'type': 'default', 'ttlSeconds': 600, 'noEnv': True, 'env': {}, 'snapshots': True,
            'from': state['preflight']['configured_snapshot']}
    resource_id = boat.launch('create-download-probe', '/sandboxes', body, 'zeros-v2-test-download-1')
else:
    resource_id = resource['id']
# The first tar.gz was 56.6 MB, so sample tar.xz as well to meet the requested
# approximate 30-50 MB size range and expose the compression cost difference.
source = (DIRECTORY / 'vm_probe.py').read_text()
source = source.replace("'-linux-x64.tar.gz'", "'-linux-x64.tar.xz'")
source = source.replace("['tar', '-xzf',", "['tar', '-xJf',")
(DIRECTORY / 'vm_probe_xz.py').write_text(source)
command = "python3 - <<'ZEROS_V2_PROBE'\nMODE = 'download'\n" + source + '\nZEROS_V2_PROBE'
try:
    notice('additional_xz_probe_requested', resource_id=resource_id)
    status, data, elapsed = API.request('POST', '/sandboxes/' + resource_id + '/commands',
                                      {'command': command, 'timeoutSeconds': 120}, timeout=210)
    require(status, data, (200,))
    if data.get('exitCode') != 0 or data.get('timedOut') or data.get('stdoutTruncated'):
        raise RuntimeError('Additional archive probe failed')
    result = json.loads(data['stdout'])
    result.update({'resource_id': resource_id, 'command_api_http': status,
                   'command_api_wall_seconds': elapsed})
    write_json('xz-download.json', result)
    state['xz_download_probe'] = result
    boat.persist()
    notice('additional_xz_probe_measured', **result)
finally:
    if created:
        boat.cleanup()
        state['finished_at'] = boat.timestamp()
        boat.persist()

```

</details>

<details>
<summary>vm_probe_xz.py — complete source</summary>

```python
"""Transported to a newly created test sandbox through Boat's commands API."""
import json
import os
import pathlib
import shlex
import shutil
import subprocess
import tempfile
import time
import urllib.request

MARKER = pathlib.Path('/home/user/zeros-v2-test-marker-1.txt')
MARKER_CONTENT = 'zeros-v2-test-persistence-marker\n'
NODE_VERSION = 'v22.20.0'
NODE_ARCHIVE = 'node-' + NODE_VERSION + '-linux-x64.tar.xz'
NODE_BASE = 'https://nodejs.org/dist/' + NODE_VERSION + '/'


def capture(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=45)
    return {'exit_code': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}


def facts():
    MARKER.write_text(MARKER_CONTENT)
    commands = {
        'nproc': ['nproc'],
        'free -m': ['free', '-m'],
        'df -h': ['df', '-h'],
        'OS release': ['cat', '/etc/os-release'],
        'kernel': ['uname', '-srmo'],
    }
    output = {label: capture(args) for label, args in commands.items()}
    limits = {}
    for p in ['/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/memory.max']:
        try:
            limits[p] = pathlib.Path(p).read_text().strip()
        except OSError:
            limits[p] = 'unavailable'
    candidates = []
    for p in ['/opt/zeros', '/usr/local/zeros-runtime', '/usr/local/zeros',
              '/opt', '/usr/local/lib/node_modules', '/usr/lib']:
        if not os.path.isdir(p):
            continue
        resolved = os.path.realpath(p)
        measured = capture(['du', '-sb', resolved])
        if measured['exit_code'] == 0:
            size = int(measured['stdout'].split()[0])
            candidates.append({'path': resolved, 'apparent_bytes': size})
    preferred = next((c for c in candidates if os.path.realpath('/opt/zeros') == c['path']
                      and c['apparent_bytes'] > 4096), None)
    chosen = preferred or max(candidates, key=lambda c: c['apparent_bytes'], default=None)
    if chosen is None:
        raise RuntimeError('No readable runtime directory for the tree probe')
    return {'commands': output, 'cgroup_limits': limits, 'tree': chosen,
            'candidates': candidates, 'marker_written': MARKER.read_text() == MARKER_CONTENT}


def hash_tree(tree):
    # Root can read the restricted browser metadata. Boat's hydration scratch files
    # are not runtime payload and can disappear between find and the checksum read.
    command = ('sudo -n find ' + shlex.quote(tree) +
               " -type f ! -name '*.ascii-dw' -print0 | sudo -n xargs -0 -r sha256sum > /dev/null")
    began = time.perf_counter()
    p = subprocess.run(['bash', '-o', 'pipefail', '-c', command],
                       capture_output=True, text=True, timeout=590)
    return {'tree': tree, 'seconds': time.perf_counter() - began,
            'exit_code': p.returncode, 'stderr': p.stderr[:1200],
            'cache_evicted': False, 'command': command}


def download_probe():
    work = pathlib.Path(tempfile.mkdtemp(prefix='zeros-v2-test-download-'))
    try:
        archive = work / NODE_ARCHIVE
        started = time.perf_counter()
        request = urllib.request.Request(NODE_BASE + NODE_ARCHIVE,
                                         headers={'User-Agent': 'zeros-v2-test-measurement'})
        total = 0
        with urllib.request.urlopen(request, timeout=120) as response, archive.open('wb') as out:
            http_status = response.status
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                out.write(block)
                total += len(block)
        download_seconds = time.perf_counter() - started
        started = time.perf_counter()
        checked = subprocess.run(['sha256sum', str(archive)], capture_output=True,
                                 text=True, timeout=60)
        checksum_seconds = time.perf_counter() - started
        if checked.returncode:
            raise RuntimeError('sha256sum failed')
        digest = checked.stdout.split()[0]
        with urllib.request.urlopen(NODE_BASE + 'SHASUMS256.txt', timeout=30) as response:
            checksums = response.read(256 * 1024).decode('utf-8')
        expected = next((line.split()[0] for line in checksums.splitlines()
                         if len(line.split()) == 2 and line.split()[1] == NODE_ARCHIVE), None)
        verified = digest == expected and expected is not None
        if not verified:
            raise RuntimeError('Public Node checksum did not match')
        extracted = work / 'extracted'
        extracted.mkdir()
        started = time.perf_counter()
        unpacked = subprocess.run(['tar', '-xJf', str(archive), '-C', str(extracted)],
                                  capture_output=True, text=True, timeout=120)
        extraction_seconds = time.perf_counter() - started
        installed_bytes = sum(p.stat().st_size for p in extracted.rglob('*')
                              if p.is_file() and not p.is_symlink())
        return {'url': NODE_BASE + NODE_ARCHIVE, 'http_status': http_status,
                'archive_bytes': total, 'download_seconds': download_seconds,
                'download_mib_per_second': total / 1048576 / download_seconds,
                'sha256sum_seconds': checksum_seconds, 'sha256sum_exit_code': checked.returncode,
                'matches_upstream_sha256': verified, 'extraction_seconds': extraction_seconds,
                'extraction_exit_code': unpacked.returncode, 'extracted_bytes': installed_bytes,
                'temporary_files_removed_before_stop': True}
    finally:
        shutil.rmtree(work)


def marker_check():
    return {'marker_present': MARKER.is_file(),
            'marker_matches': MARKER.is_file() and MARKER.read_text() == MARKER_CONTENT}


if __name__ == '__main__':
    mode = globals().get('MODE', 'facts')
    if mode == 'facts':
        result = facts()
    elif mode in ('cold', 'warm'):
        result = hash_tree(globals()['TREE'])
    elif mode == 'download':
        result = download_probe()
    elif mode == 'marker':
        result = marker_check()
    else:
        raise RuntimeError('Unknown probe mode')
    print(json.dumps(result, sort_keys=True))

```

</details>

<details>
<summary>run_checks.py — complete source</summary>

```python
#!/usr/bin/env python3
"""Run the mandated local baseline and a Boat-only agent:check without logging secrets."""
import json
import os
import subprocess
import time

from boat_measure import DIRECTORY, ROOT, ENV, safe_text, timestamp, write_json

CHECKS = [
    ['pnpm', 'agent:check', '--file', '/dev/stdin'],
    ['pnpm', 'typecheck'],
    ['pnpm', 'lint'],
    ['pnpm', 'check:ui'],
    ['pnpm', 'test:git'],
    ['pnpm', 'check:secrets'],
]
results = []
for index, command in enumerate(CHECKS):
    environment = dict(os.environ)
    payload = None
    if index == 0:
        # Feed only the two permitted Boat variables to the original checker in memory.
        # Remove every .env.agent name from inherited env so no other provider can run.
        for name in ENV:
            environment.pop(name, None)
        environment['NODE_OPTIONS'] = '--import=' + str(DIRECTORY / 'agent_check_preload.mjs')
        payload = ''.join(name + '=' + ENV[name] + '\n'
                          for name in ['BOAT_API_KEY', 'BOAT_BILLING_ORG'])
    began = time.perf_counter()
    print(json.dumps({'event': 'check_started', 'command': command, 'at': timestamp()}), flush=True)
    log = DIRECTORY / ('check-' + command[1].replace(':', '-') + '.log')
    process = subprocess.Popen(command, cwd=ROOT, env=environment,
                               stdin=subprocess.PIPE if payload else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if payload:
        process.stdin.write(payload)
        process.stdin.close()
    with log.open('w') as output:
        for line in process.stdout:
            output.write(safe_text(line))
    code = process.wait()
    result = {'command': command, 'exit_code': code, 'seconds': time.perf_counter() - began,
              'log': log.name}
    results.append(result)
    write_json('checks.json', results)
    print(json.dumps({'event': 'check_finished', **result}), flush=True)
print(json.dumps({'event': 'all_checks_finished', 'results': results}), flush=True)

```

</details>

<details>
<summary>agent_check_preload.mjs — complete source</summary>

```javascript
// Keep the required repository credential check restricted to Boat and Python urllib.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bridge = fileURLToPath(new URL('./urllib_bridge.py', import.meta.url));
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://boat.dev/api/v1/')) {
    throw new Error('This measurement authorizes only Boat provider requests');
  }
  const request = {
    url: String(url),
    method: init.method ?? 'GET',
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body: init.body ?? null,
  };
  const result = spawnSync('python3', [bridge], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Boat read-only credential transport failed');
  const response = JSON.parse(result.stdout);
  return new Response(response.body, { status: response.status, headers: response.headers });
};

```

</details>

<details>
<summary>urllib_bridge.py — complete source</summary>

```python
"""Private stdin/stdout transport for agent:check; never called with credential arguments."""
import json
import sys
import urllib.error
import urllib.request

from boat_measure import ENV, NoRedirect

data = json.load(sys.stdin)
if not data['url'].startswith('https://boat.dev/api/v1/') or data['method'] != 'GET':
    raise SystemExit('Only read-only Boat requests are allowed')
headers = data['headers']
headers['X-Boat-Org'] = ENV['BOAT_BILLING_ORG']
request = urllib.request.Request(data['url'], method='GET', headers=headers)
try:
    response = urllib.request.build_opener(NoRedirect()).open(request, timeout=20)
except urllib.error.HTTPError as error:
    response = error
with response:
    result = {'status': response.code, 'body': response.read(2 * 1024 * 1024).decode('utf-8'),
              'headers': {'Content-Type': response.headers.get('Content-Type', 'application/json')}}
# This goes only to the original checker process, not terminal output or a file.
sys.stdout.write(json.dumps(result))

```

</details>

<details>
<summary>final_audit.py — complete source</summary>

```python
#!/usr/bin/env python3
"""Final read-only verification of every owned id and the shared start budget."""
import collections
import json
import subprocess

from boat_measure import API, DIRECTORY, ROOT, require, timestamp, write_json, notice

state = json.loads((DIRECTORY / 'results.json').read_text())
result = {'at': timestamp(), 'sandboxes': {}, 'start_attempts': len(state['start_attempts'])}
for resource_id in state['resources']:
    status, _, _ = API.request('GET', '/sandboxes/' + resource_id)
    result['sandboxes'][resource_id] = status
status, data, _ = API.request('GET', '/named-snapshots/zeros-v2-test-snap')
result['test_named_snapshot_get_http'] = status
status, data, _ = API.request('GET', '/limits')
require(status, data, (200,))
result['limits_http'] = status
result['active_sandboxes'] = data.get('activeSandboxes')
result['starts'] = {k: {field: row.get(field) for field in ['used', 'remaining', 'limit']}
                    for k, row in (data.get('starts') or {}).items() if isinstance(row, dict)}
name = state['preflight']['configured_snapshot']
status, data, _ = API.request('GET', '/named-snapshots/' + name)
snapshot = data.get('snapshot') or {}
result['alpha_base_snapshot'] = {
    'name': name, 'http': status, 'status': snapshot.get('status'),
    'size_bytes_unchanged': snapshot.get('sizeBytes') == state['preflight']['configured_snapshot_size_bytes'],
}
events = [json.loads(line) for line in (DIRECTORY / 'http-events.jsonl').read_text().splitlines()]
result['start_http_dispatches'] = sum(e['method'] == 'POST' and
    (e['path'] == '/sandboxes' or e['path'].endswith('/fork') or e['path'].endswith('/resume'))
    for e in events)
result['all_recorded_boat_calls_scoped'] = all(e['billing_org_header_sent'] for e in events)
result['http_status_counts'] = dict(collections.Counter(str(e['http']) for e in events))
result['unexpected_provider_http_events'] = [e for e in events if e['http'] not in [200, 202, 404]]
result['tracked_status_final'] = subprocess.check_output(['git', 'status', '--short'], cwd=ROOT, text=True)
result['branch_final'] = subprocess.check_output(['git', 'branch', '--show-current'], cwd=ROOT, text=True).strip()
result['all_owned_ids_get_404'] = all(code == 404 for code in result['sandboxes'].values())
write_json('final-audit.json', result)
notice('final_audit', **result)
if not result['all_owned_ids_get_404'] or result['test_named_snapshot_get_http'] != 404:
    raise SystemExit('Cleanup verification failed')
if result['start_http_dispatches'] > 10 or result['start_attempts'] > 10:
    raise SystemExit('Start budget exceeded')

```

</details>

<details>
<summary>verify_artifacts.py — complete source</summary>

```python
#!/usr/bin/env python3
"""Check this private report directory for credential values and evidence consistency."""
import json
import re
import subprocess

from boat_measure import DIRECTORY, ENV, ROOT, write_json

findings = []
files = [p for p in DIRECTORY.rglob('*') if p.is_file()]
for file in files:
    contents = file.read_bytes()
    for name, value in ENV.items():
        if len(value) >= 8 and value.encode() in contents:
            findings.append({'file': str(file.relative_to(DIRECTORY)), 'variable_name': name})
    if file.suffix in ['.py', '.mjs', '.md', '.json', '.jsonl', '.log']:
        text = contents.decode('utf-8')
        # Match bodies, not the bare prefixes in the redactor's source.
        tokens = re.search(r'\b(?:boat_|ghs_|gho_|ghp_|ghu_|github_pat_|condw_|sk-|sk_)[A-Za-z0-9_-]{24,}', text)
        if tokens:
            findings.append({'file': str(file.relative_to(DIRECTORY)), 'issue': 'token-shaped value'})
state = json.loads((DIRECTORY / 'results.json').read_text())
audit = json.loads((DIRECTORY / 'final-audit.json').read_text())
events = [json.loads(line) for line in (DIRECTORY / 'http-events.jsonl').read_text().splitlines()]
resources = set(state['resources'])
foreign_mutations = []
for event in events:
    if event['method'] == 'GET':
        continue
    path = event['path']
    if path in ['/sandboxes', '/named-snapshots', '/named-snapshots/zeros-v2-test-snap']:
        continue
    resource = re.match(r'^/sandboxes/(bx_[23456789abcdefghjkmnpqrstuvwxyz]{8})(?:/|$)', path)
    if not resource or resource[1] not in resources:
        foreign_mutations.append({'method': event['method'], 'path': path})
status = subprocess.check_output(['git', 'status', '--short'], cwd=ROOT, text=True)
result = {'files_checked': len(files), 'credential_findings': findings,
          'foreign_mutations': foreign_mutations, 'tracked_status': status,
          'start_count': len(state['start_attempts']), 'sandbox_count': len(resources),
          'all_created_resources_verified_absent': audit['all_owned_ids_get_404'],
          'test_snapshot_verified_absent': audit['test_named_snapshot_get_http'] == 404,
          'report_exists': (DIRECTORY / 'REPORT.md').is_file()}
write_json('artifact-verification.json', result)
print(json.dumps(result, sort_keys=True))
assert not findings and not foreign_mutations and not status
assert result['start_count'] == 8 and result['sandbox_count'] == 7
assert result['all_created_resources_verified_absent'] and result['test_snapshot_verified_absent']

```

</details>
