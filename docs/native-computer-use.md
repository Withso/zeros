# Native Codex computer and browser use

Zeros runs Codex through its pinned app-server. The installed Computer Use,
Chrome and Browser plugins remain provider capabilities; Zeros does not bundle
a replacement computer-control implementation or copy the user's browser
credentials. The provider owns its tool definitions, skills, hooks, application
and website approvals, and control-session lifecycle.

## Runtime and profile ownership

Codex Desktop materializes its bundled plugins as `source.type = "local"`.
That source type alone cannot distinguish a user-authored MCP from the native
computer/browser runtime. `bundled-runtime-plugins.ts` admits only the recognized
`openai-bundled` runtime names, with matching plugin/marketplace identity, a
materialization under the session's selected `CODEX_HOME`, and a matching
manifest. Both current directory copies and older links into that home's
versioned plugin cache are supported. This is provenance classification, not a
signature verifier.

The exception does not enable a disabled plugin, admit arbitrary local packages,
borrow another account's plugin cache, or override a config-declared MCP with the
same name. Direct local MCP declarations still require **Customize → Import**.
Restricted actors and tool-free helper threads continue to exclude native
plugins. Zeros' existing browser binding and provider stop/interrupt hooks
remain in place.

Native configuration follows the profile actually selected for execution.
An adopted CLI account using the desktop's Codex home can reuse that profile's
installed runtime and settings. A separately signed-in, isolated Codex profile
does not automatically receive another profile's local plugins or configuration.
Subscription authentication is not a settings-sync API. The helper and Chrome
extension must also exist on the execution Mac; a cloud engine does not acquire
control of a user's laptop merely by signing into the same account.

## Permissions

Computer use setup is managed in Codex/ChatGPT and macOS System Settings.
For the native provider implementation, OpenAI's setup instructions name
**Codex Computer Use** for Accessibility and Screen Recording. Shell tools that
run `osascript` or `screencapture` take a different path: macOS checks the
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

Zeros has no separate Computer use settings page. The Tools inventory reports
the selected session's runtime connection; it does not equate that connection
or the helper's installation with macOS permission readiness.

The user enables permissions in macOS and restarts the helper if requested.
Codex still enforces app/site approval, browser profile selection, locked-use
preferences, organization policy, and user stop/deny decisions. Zeros forwards
provider approval requests through its existing permission handling; it does
not silently grant access or change these preferences.

Official setup references: [Computer Use](https://learn.chatgpt.com/docs/computer-use),
[Chrome extension](https://learn.chatgpt.com/docs/chrome-extension), and
[App Server](https://learn.chatgpt.com/docs/app-server). Apple's
[Apple Events entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events)
describes the separate requirement for requesting Automation consent.

## Transcript contract

Native `cua_repl.js` and `node_repl.js` retain their provider-authored action
titles and ordinary Zeros tool-row expansion. Completion results become
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
