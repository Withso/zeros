---
name: zstack-drive
description: "Launch, diagnose, drive and capture Zeros user flows: the native app on macOS and production renderer fixtures on Linux. Use for hands-on app verification and locating workspace, chat, file, Git and terminal features."
---

<!-- GENERATED from agents/zstack/skills/zstack-drive/SKILL.md by scripts/design-system/build-design-docs.mjs. Edit it there, then run `pnpm design:docs`. -->

# Drive Zeros

Start with `zstack` and the task's existing authorization. All paths below are
relative to the repository root. Record the checkout/revision, host, owner,
placement, chosen flow and expected visible result before launching. Use a
disposable project for writes. Do not turn a UI check into a new provider turn,
deployment or cloud resource unless that work is authorized.

## Choose the surface

| Host / purpose | Launch and limits |
| --- | --- |
| macOS, Local features | `pnpm electron:local` opens the real account-free desktop, engine, Git and PTYs. Only the Local Personal owner is available. |
| macOS, organization/cloud features | Use the already authorized Dev or local cloud stack; see `docs/electron-cloud.md`. `pnpm electron:cloud` can publish a runtime and provision remote resources. |
| Linux cloud workspace | Use the browser path below. `electron:local` explicitly refuses Linux. Production renderer components run with fixture I/O; native engine, actual PTYs, provider turns and Boat lifecycle remain unverified. |

Do not change platform checks or fabricate a native bridge to make the full app
appear supported. A Conductor cloud host and a Zeros cloud placement are different
things: browser fixtures can cover placement UI without running a Boat worker.

## Launch and check

Use the repository's Node/pnpm toolchain and frozen dependencies. If working
alongside other agents, use the agreed heavy-check slots. A Mac Local launch
needs only the root dependency graph; follow `docs/local-development.md` for
native prerequisites. Run one launcher per checkout: Local and Dev share build
outputs. Keep the launch in its own foreground terminal so its Stop signal owns
cleanup.

Run `pnpm doctor` before and after. It is a read-only process/memory census,
not a readiness or health test. Confirm the intended app/fixture actually loads
and performs one observable action. Use `pnpm electron:cloud --doctor` only for
an authorized cloud stack; keep private profile contents out of evidence.

For Linux browser verification (also available on a Mac):

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm doctor
pnpm test:ui-smoke --list --format=json
VITE_CONTROL_PLANE_URL=https://api.example.test pnpm exec vite --mode ui-smoke --host 127.0.0.1 --port 6217 --strictPort
```

Leave Vite running in that terminal. If the port is occupied, select another
free loopback port and keep `--strictPort`. From the available browser tool or
Playwright, open `http://127.0.0.1:6217/apps/desktop/src/renderer/harnesses/` plus
the map's HTML filename. Wait for the map's visible ready state; drive its
controls and assert the end state before capturing. Keep fixture pages in fresh
browser contexts so stored state cannot leak between flows. These development
harnesses import the product components; their I/O is simulated.

For the maintained automated interaction checks, run
`pnpm test:ui-smoke --shard=2/3` or `--shard=3/3` according to the current list.
The runner launches and cleans up its own Vite and Chromium. A shard is partial
evidence; list what ran. `scripts/ui-smoke/scenarios.mjs` owns scenario-to-driver
mapping and `scripts/ui-smoke/shards.json` owns the current partition.

## Feature map

Read only the maps needed for the task. Each contains native reach/drive steps,
a deterministic browser route, an observable end state and placement gotchas.

| Feature | Map |
| --- | --- |
| Workspace navigation and owners | `agents/zstack/drive/features/workspaces.md` |
| Chat, composer and transcript | `agents/zstack/drive/features/chat.md` |
| Files and editor saves | `agents/zstack/drive/features/files.md` |
| Git changes and review | `agents/zstack/drive/features/git.md` |
| Terminals and run sessions | `agents/zstack/drive/features/terminals.md` |

On native macOS, drive the launched window with desktop automation actually
available to the host, or perform the named manual flow. A browser tab pointed
at Vite does not prove the Electron bridge. When the host cannot control or
capture the native app, report that exact gap rather than a native pass.

## Evidence and cleanup

Save screenshots under `.context/zstack-drive/<run>/` in your own checkout.
With Playwright, call `page.screenshot({ path, fullPage: true })` after the
assertion. Record the route/feature, host, owner/placement, assertion result,
source revision and whether transport was real or fixture-backed. A screenshot
alone does not prove persistence, a completed provider turn or a live VM.
Capture the task's surface only; omit credentials, private profiles and raw
provider/session dumps. Native performance claims additionally need the
measurements required by `zstack-verify`.

Close your browser contexts and browser, then send Ctrl+C/Stop to your Vite or
Local launch and wait for exit. For an authorized cloud stack use its documented
`--stop`; that preserves its data. Remove only disposable resources you created
and intended to remove. Do not kill processes belonging to another checkout.
Wait until the listener closes; a package-manager parent can exit before its
child finishes. Run doctor again and confirm your launch is gone. Leave a receipt of
passed flows, evidence paths and exact unverified native/live-cloud follow-ups.
