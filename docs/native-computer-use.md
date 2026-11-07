# Computer use

Zeros runs Codex through its pinned app-server. Codex uses Zeros computer use
and the Zeros browser like every agent: Zeros turns OpenAI's bundled Browser,
Chrome, Computer Use and Unified Computer Use plugins off on every Codex
thread, and disables the computer-use `cua_repl` / `computer-use` servers by
name (`adapters/codex/built-in-plugins.ts`). Native MCP discovery disables the
plugins' other servers like any unimported local server. One path keeps
blocked apps, the control bar, Stop and parallel chats the same for every
agent. Zeros does not copy the user's browser credentials.

**Settings → General → Computer use** controls Zeros' own computer-control
runtime (the pinned Cua driver below), which every local agent family uses
through `zeros computer` or the `zeros_computer` tools. It is available and
enabled by default for every user; explicit opt-outs and managed restrictions
still take precedence. Zeros requires the Mac's Accessibility and Screen
Recording grants (shown under Settings → General → Privacy), and blocked apps
stay off limits. Agents use any other app without asking. The
[rollout](agent-control.md#rollout) has reached the public `default` stage,
with no Internal switch.

## Zeros computer use (Cua driver)

The Zeros computer-use runtime runs in the Electron main process, not the
engine: screen and input control follow the app's macOS TCC grants, so the
feature exists for Local workspaces only and is honestly unavailable in cloud
workspaces. `electron/computer-use/` owns the driver host (private worker
lifecycle with bounded restart backoff, trusted sessions with TTLs, and
allowlisted, host-authored failure text); `src/engine/agents/` exposes the
`zeros_computer` MCP tools to Claude, Codex, and Cursor sessions when the
user's settings allow them.

The npm package `@trycua/cua-driver` is only the SDK. The process that
performs control is the separate `cua-driver` executable, published on the
matching `trycua/cua` GitHub release and shipped by no npm archive:

- `scripts/stage-cua-driver.mjs` (`pnpm stage:cua-driver`) downloads the
  pinned `cua-driver-rs-<version>-darwin-universal-binary.tar.gz`, verifies
  its SHA-256, extracts the executable, thins it to arm64 with `lipo` (which
  preserves the hardened-runtime signature), and re-verifies the Developer ID
  authority. The version, URL, and hash are pinned in the script and must move
  together with the `@trycua/cua-driver` dependency and its platform package
  pin (below); the script refuses to stage when either pin differs.
- Development resolves `binaries/cua-driver`; the packaged app resolves
  `Contents/Resources/cua-driver` via an `extraResources` entry, and
  `beforePack` runs the staging script so every packaging entrypoint gets it.
- The SDK's native node runtime and `libcua_driver_sdk.dylib` are dlopen'd by
  path, so `@trycua/**` and `@ubjs/**` sit in `asarUnpack`, and the packaged
  main process imports the SDK from `app.asar.unpacked`
  (`importCuaSdk` in `electron/computer-use/driver.ts`).
- Those two files ship in the SDK's optional platform package,
  `@trycua/cua-driver-darwin-arm64`, which `package.json` also lists under
  `optionalDependencies` at the SDK's exact version. electron-builder's pnpm
  collector packs an optional dependency only when it is linked at the
  repository root, which pnpm never does for a transitive one; without the
  root entry the packaged app silently lacks the SDK's native library.
- `pnpm check:packaging-paths` name-matches the staged path, the
  `extraResources` entry, the `asarUnpack` globs, and the staging script's
  hash/`lipo`/`codesign` steps.

The driver's MPL-2.0/MIT terms and its upstream NOTICE are inventoried in
`THIRD-PARTY-LICENSES.txt` with reviewed copies under
[`third_party/trycua-cua-driver/`](../third_party/trycua-cua-driver) and
[`third_party/mpl-2.0/`](../third_party/mpl-2.0); see
[`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).

Permissions follow the host app: the driver runs embedded, so Accessibility
and Screen Recording grants belong to Zeros itself, and the Settings page
walks the user through granting them (status polling, request, and deep links
into System Settings). App and simulator approvals arrive as permission cards
in the requesting chat and are answered through the agent-control contract in
[`agent-control.md`](agent-control.md). Transcript rows reuse the browser
activity card with a computer surface; a chat waiting for an app another chat
is using shows a waiting line ("Waiting for Codex in another chat to finish
using Safari") instead of the queued action.

Several chats can use the Mac at once (`electron/computer-use/controller.ts`).
A chat leases each app it acts in, by bundle ID, until its turn ends, its
composer Stop, a denied app, a driver failure or the user blocking that app;
another chat that wants the same app waits in that app's line, first come
first served, for up to five minutes. Two chats that would wait for each
other's apps are refused at once. Listing apps and windows takes no lease.
Chats share one app listing for 30 seconds, because the driver's listing walks
every installed app (about a second); a call that sees an app the listing
misses reads it again. An app Zeros launches takes the pid its launch reports,
a page opened in a running app keeps the listing, and any other open discards
it.
Input is delivered in the background, so chats in different apps never
interrupt the user or each other. Only actions macOS delivers to the frontmost
window (modified clicks, drags, the ambiguous-key retry) take turns, one driver
call at a time across all chats. The control bar names every chat acting ("Claude Code and Codex are using Safari
and Notes"); its Stop stops all of them, and a composer Stop stops only that
chat. The bar never claims a key: agents work in the background while the user
keeps typing in other apps, so Esc stays with whatever app the user is in.

Each chat has one trusted driver session for all of its apps. Its public label
is the agent's name, numbered for an agent's later sessions ("Claude Code 2"),
because the driver never gives a closed session's label to another; the label
names that chat's agent cursor. Closing a session ends its label with
`end_session` first. Keys sent to one window of an app with several are
retried once in the foreground when the driver refuses them as ambiguous.

## Runtime and profile ownership

Codex Desktop materializes its bundled plugins as `source.type = "local"`.
Zeros gives them no exemption: like every local package, their MCP servers are
disabled unless imported through **Customize → Import**, and their plugin gates
are off. Restricted actors and tool-free helper threads exclude the whole disk
plugin surface. Native configuration follows the profile actually selected for
execution; a separately signed-in, isolated Codex profile does not receive
another profile's local plugins or configuration.

Zeros passes its own servers (`zeros_computer`, `zeros_browser` and the rest)
to `codex app-server` with `-c`. The `thread/start` and `thread/resume`
`mcp_servers` table that disables native servers replaces those `-c` servers for
that thread, so it restates each Zeros server exactly as `-c` passed it
(`mcpDisabledThreadConfig`). Check what a thread really has with
`mcpServerStatus/list` and its `threadId`; without one, Codex reports the
process-level set.

Organization cloud workspaces explicitly report **Native browser is unavailable
in cloud workspaces.** Claude's Chrome integration requires a direct Claude login, not an
API key or setup token. Neither provider's cloud chat sign-in grants browser or
computer control. The shared provider/session UI and Browser settings explain
these limits without offering installation on the user's Mac. Ordinary cloud
chat, user MCP and workspace port previews retain their separate availability.

The [browser capability contract](browser-service.md#organization-cloud-availability-and-compatibility)
is an optional versioned diagnostic scoped to provider, runtime and credential
kind. Older engines omitting it mean unavailable, never ready. It does not
change the existing native execution profile or Local browser defaults, and
does not constitute full cloud browser parity.

## Permissions

Zeros computer use needs Accessibility and Screen Recording granted to Zeros
itself; Settings → General → Privacy shows both next to Full Disk Access and
opens System Settings. Full Disk Access grants neither. Shell tools that run
`osascript` or `screencapture` take a different path: macOS checks the
responsible app for that process chain. A development session launched by an IDE
or terminal can remain attributed to that launcher. The app being controlled is
not automatically the app that needs the grant. Do not infer the permission
owner from the Zeros window title, the helper's installation, or a successful
permission query in the Electron process.

Apple Events automation is a separate permission. Native helper clients can
also use Apple Events when communicating with the helper. Signed Zeros builds
declare `com.apple.security.automation.apple-events`; packaged and development
bundles include `NSAppleEventsUsageDescription`. These enable macOS's consent
flow, not automatic access. A third-party launcher that remains responsible
must satisfy its own signing requirements; changing Zeros' plist cannot supply
a missing entitlement to that launcher. Test the independently launched app
when validating permissions for a packaged release.

To diagnose a failure, correlate the tool-call timestamp with macOS `tccd`
attribution and authorization results for the specific permission. Accessibility
denial, missing Automation entitlements, and missing tools are distinct failures.
A generic "enable Zeros" instruction is not reliable without that attribution.

Codex's own computer use and Browser plugins are disabled on every Zeros
thread, so their setup and grants in Codex/ChatGPT do not affect Zeros chats.

Apple's
[Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events)
describes the separate requirement for requesting Automation consent.

## Transcript contract

Native `cua_repl.js` and `node_repl.js` rows (older transcripts, from before
Zeros disabled Codex's plugins) retain their provider-authored action titles and ordinary Zeros tool-row expansion. Completion results become
canonical text/image content so screenshots are visible without exposing a
base64 JSON envelope. Provider failure status, explicit `isError`, and native
timeouts remain failures. Background MCP startup/reconnect messages remain in
Tools and do not create repeated transcript warnings.

`_meta["codex/toolSurface"]` is authoritative over the older browser-use boolean.
Computer calls carry a bundle identifier (`app.kind = "appId"`, with legacy
`"mac"` support). Browser calls carry backend/profile identity and the recorded
tab/page. A screenshot's exact tab ID can supply its favicon; an unrelated first
open tab cannot. Chrome and separate profiles do not borrow the embedded
browser's live page or merge into its activity group. Calls without identity
keep the existing action glyph.

App artwork comes from thread-scoped `app/installed` and `app/read`; plugin
artwork from installed plugin metadata; MCP artwork from the tool/server icons
in the paginated session inventory. Presentation-only `_zerosToolArtwork` lives
inside the existing opaque `rawInput`, without a new required wire field.
Metadata requests are shared, bounded and fail quietly. Late responses cannot
revert a tool's result/status or attach to a replacement turn/session.

Native app artwork is extracted from installed bundles using Launch Services
(Spotlight fallback), verified bundle identity, and `sips`. Applications are not
launched. No vendor artwork is copied into the repository. These images depict
the named app; they are not proof that an application is installed or authorized
on a remote execution host.

Website favicons prefer provider/cached artwork, then the recorded public origin's
favicon. Optional HTTPS artwork is fetched anonymously by a narrow native IPC,
without browser cookies, referrers, or caller-authored request headers. Every
redirect is validated and DNS results are checked and pinned at socket creation.
Reads have byte, timeout, redirect and batch limits. Only bounded passive image
data reaches the renderer; invalid/missing artwork falls back to existing icons.
The browser-only harness can use anonymous CORS images without a native bridge.

Artwork caches belong to the native bridge and exact app/URL. Hidden transcript
surfaces stop reads and release rendered screenshots.

## Verification

Adjacent tests cover bundled runtime provenance, local overrides, account-home
isolation, artwork pagination and races, explicit tool failures and screenshot
content, exact browser tab identity, bounded image requests, and native command
validation. `ui-smoke-native-tools.mjs`, included in `pnpm test:ui-smoke`, exercises
native identity in individual/collapsed rows, light/dark artwork, screenshots,
failure visibility, inactive surfaces and host changes.

Mac checks must run against installed applications and the real helper. A
read-only native `cua.getState()` probe requires the provider's turn metadata;
an out-of-turn MCP request is not a valid readiness test for browser services.
Such an inventory probe does not establish that every application action is
authorized. End-to-end clicks, screenshots, denied permissions, interruption
and locked use still depend on the user's execution host and provider policy.
