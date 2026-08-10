# Codex app-server compatibility

Zeros uses the long-lived Codex app-server as its interactive Codex runtime.
The [official app-server contract](https://learn.chatgpt.com/docs/app-server)
is the authority for authentication, threads, turns, approvals, and streamed
events. The Codex SDK powers explicit headless jobs and CI automation; it does
not replace app-server in the desktop chat path.

## Compatibility boundary

Full Codex compatibility means that every public method in the protocol version
pinned by `package.json#codexProtocolVersion` is deliberately classified and
that every enabled interaction can finish without a silent drop or stranded
request. Zeros keeps its own chat, tool-card, terminal, diff, worktree, and
workflow UI. Compatibility is semantic, not a copy of another client's visual
interface.

The enforcement boundary covers both directions:

- `ClientRequest`: every method Zeros can initiate, including thread, turn,
  account, extension, MCP, process, environment, and remote-control surfaces.

- `ServerRequest`: a blocking request that Zeros must answer or reject safely.
- `ServerNotificationEnvelope`: streamed lifecycle and content that Zeros must
  translate, consume, deliberately omit, or record as planned work.

The current pin contains 211 classified methods: 128 client requests, 11
blocking server requests, and 72 server notifications. Of those, 123 are
supported, 46 are partial, and 42 are not applicable to Zeros; none remain
unclassified or merely planned. Classification prevents generated methods from
remaining invisible and distinguishes product support from an authenticated
runtime escape hatch.

## Coverage manifest

`apps/desktop/src/engine/agents/adapters/codex/protocol-coverage.json` is the
maintained compatibility manifest. Its protocol version must match the package
pin, and its keys must exactly match the generated request and notification
unions.

Each method has one state:

- `supported`: Zeros preserves or acts on the semantics required by its current
  product surface.
- `partial`: Zeros has a typed or receiving bridge but intentionally preserves
  only part of the method's semantics today.
- `planned`: the generated method is known but its product/runtime bridge is not
  implemented yet.
- `not-applicable`: the method belongs to a legacy or platform boundary Zeros
  does not advertise; the reason must explain the safe behavior.

Every non-supported entry requires a reason and an owner. A method may move to
`supported` only with adjacent behavior tests, not merely because a listener was
registered.

Run the offline gate with:

```sh
pnpm check:codex-coverage
```

`pnpm check:codex-pin` also runs this gate, so the existing preflight and release
checks reject a protocol regeneration that adds, removes, or renames a
method without a corresponding review. The gate checks both directions:

- a generated method absent from the manifest is unclassified drift;
- a manifest method absent from generated bindings is a stale compatibility
  claim.

## Implementation order

The blocking bridge now handles approval requests, user questions, standard MCP
forms, MCP URL confirmations, host time, dynamic tool calls, and externally
resolved request cleanup. The OpenAI extended-form MCP capability remains
unadvertised until its arbitrary schema and UI contract can be validated end to
end.

The desktop package stages the complete platform-specific runtime for the
protocol pin under `Resources/codex-runtime`. Electron passes its binary path,
managed-package root, and expected version to the engine, so a packaged build
does not silently fall back to an unrelated `codex` on the user's `PATH`.

The implemented stack now includes provider-negotiated host-auth refresh and
attestation seams, typed SDK jobs, separate Zeros/native thread identities,
atomic native thread forks, native archive/delete/unarchive/name/pin metadata
synchronization, Guardian-denial approval retry, hook and model reroute
translation, and a local-only capability bridge. Settings → Codex platform
exposes account, plugin, app, skill, MCP, remote-control, model, permission,
collaboration, hook, experiment, task goal, memory, marketplace, background
terminal, and Windows sandbox surfaces. Destructive global memory reset and
marketplace removal require an explicit confirmation. Mutations are an
explicit allowlist; the renderer cannot issue arbitrary JSON-RPC.

Native thread resume now atomically reconciles the provider's title, pin, and
typed Git metadata into the matching Zeros chat. Git metadata is descriptive
and never changes the selected checkout. Settings can inspect a complete native
thread history through bounded cursor pagination without resuming or importing
that thread. Account settings expose native sign-in/out, usage, rate-limit
windows, earned resets, workspace messages, and confirmed owner notifications.
MCP startup and OAuth completion notifications are retained per live thread and
merged into status reads so reauthentication failures remain actionable.

The manifest remains the granular source of truth. A typed bridge is marked
`partial` until its complete product semantics have adjacent tests. Realtime
voice now includes voice discovery, microphone PCM capture with bounded
backpressure, ephemeral audio delivery, playback, text/speech input, and
active-session cleanup. Remaining partial coverage is concentrated in legacy
process/filesystem/config endpoints, host-specific Windows runtime validation,
and protocol surfaces that have no complete Zeros product workflow. Deprecated
`thread/rollback` must not be presented as a file rollback; Zeros' own turn
reset remains the safer user workflow.

Browser control does not extend the ordinary renderer iframe into an automation
security boundary. Agent-owned tabs instead adopt the isolated Electron guest
into a native `WebContentsView`, so the user and agent share one live document
without exposing it to renderer page script. Ordinary manual and Design tabs
retain the iframe fallback. Durable task-scoped traces and browser/device
permission tiers are implemented at the native host boundary.

## Browser compatibility

Zeros currently provides retained manual Browser tabs, back/forward/reload,
address-or-search input, local-preview element selection, and routing from
Codex chat links and MCP URL confirmations into the Browser. `Cmd+Shift+B` on
macOS and `Ctrl+Shift+B` elsewhere reveal or create the active Browser tab.

The existing iframe remains only the manual-preview and local Design/Canvas
layer. It is not an automation or trust boundary and never receives Codex
credentials or privileged Chrome DevTools Protocol access. When Codex first
opens a site, the renderer creates an exact task-bound Browser tab and Electron
mounts the agent's existing guest `WebContents` into that tab. Hidden tabs
detach the native view and remain inert; a stale persisted binding falls back
to the ordinary iframe rather than showing a dead surface.

New Codex threads advertise a native `zeros_browser` dynamic-tool namespace
(`browser` itself is reserved by Codex's Responses API).
`item/tool/call` is routed through a random-token, loopback-only bridge to an
ephemeral main-process Electron profile owned by the stable Zeros task. Native
dynamic tools and resumed MCP connections carry the same validated task
binding, so App Server reconnects do not fork or erase the browser lease. The bridge
supports open/navigate, semantic snapshots, click, type, back/forward/reload,
responsive resizing, screenshots, traces, annotations, bounded downloads,
approved uploads and password entry, scoped browser/device permissions, and
close. Popups and non-HTTP(S) navigation remain denied. Consequential actions
are classified in the main process and pause behind an explicit renderer-owned
confirmation. Allow-site decisions are
task/origin/category scoped and can be revoked from the live Browser toolbar.
Leases are bounded by count and idle lifetime. Console failures, failed network
requests, HTTP error responses, and downloads are retained as bounded task
diagnostics and included in snapshots and durable traces. An isolated renderer
crash closes only its task lease and publishes a close event so the next open
creates a clean session. Provider switches close every old native task binding,
and CDP-backed providers retry one interrupted open against a fresh connection.

The same loopback host also exposes an authenticated Streamable HTTP MCP
server. Zeros injects a task-bound endpoint into every Codex app-server child
at spawn time, so a task created before dynamic browser tools existed gains the
same browser actions and the same lease when it is resumed. Read-only browser
actions advertise safe MCP annotations; interactive click and type actions
retain approval semantics.

Screenshots are persisted with private permissions in a bounded per-task app
data bucket. The translator stores them as canonical chat image/resource
content, so they survive transcript reload and can be revealed in Finder.

Opt-in developer CDP is implemented and still requires approval for the exact
site and method. Shared Chrome is now a separate, explicit provider: the user
launches Chrome with a loopback DevTools endpoint, chooses Shared Chrome in
Settings, and Zeros creates one dedicated Chrome target per task. Zeros speaks
CDP directly, never copies cookies or profile files, closes only targets it
created, blocks browser-terminating CDP methods, and verifies by smoke test that
disconnecting leaves Chrome running. Provider changes take effect for existing
and new Codex sessions without rebuilding the agent session.

macOS System Computer Use is a separate provider with Accessibility and Screen
Recording readiness, native permission prompting, screenshots, pointer input,
typing, and keyboard actions. Every mutating action remains confirmation-gated.
Managed cloud browser sessions use an explicit endpoint and OS-encrypted bearer
token, authenticated discovery and WebSocket transport, secret-redacted errors,
lease recovery, and live reconnection when settings change. These providers
remain separate because their consent, credentials, lifecycle, and evidence
boundaries differ; none is silently substituted for the isolated Electron
profile or Shared Chrome. Authenticated managed-cloud discovery accepts only
same-host WSS, and loopback Chrome discovery cannot redirect the client to a
remote DevTools socket. Windows packaging and real Windows sandbox/browser
permission validation still require a Windows host.

The interactive desktop remains app-server driven. SDK integration is isolated
to trusted headless jobs; using an SDK in the renderer would weaken thread
synchronization and approval semantics.
