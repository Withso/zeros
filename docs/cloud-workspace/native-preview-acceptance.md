# Native preview acceptance on Mac Alpha

Status: acceptance procedure, not a live qualification result. E2 adds native
Browser/Run/agent HTTP and HMR admission on E1. This procedure is run by the
orchestrator from its credential-holding workspace and signed Alpha Mac app.
No provider API, deployment or release workflow was run for E2 implementation.

## Prerequisites and private evidence

1. Complete C5 template forks/projections, B8 wake/recovery pin preservation and
   B10 boot/restore persistence qualification. Use a fresh B10 base and sanitized
   Cloud Computer template. Consume their completed qualification receipts;
   older Boat experiments are not implementation proof.
2. Deploy the E2 control plane with migration 0130 and qualify an E2 runtime.
   Confirm the Alpha desktop includes E1 and E2 and its preview-domain allowlist
   matches the control plane's configured TLS domain. Do not change Beta or
   Production. Wake an existing pinned runtime only through B8's normal flow;
   it must not silently upgrade to E2.
3. In the orchestrator's workspace run `pnpm agent:check` read-only using its
   gitignored `.env.agent`. Do not transfer credentials into another workspace
   or print their values. Use the signed Mac Alpha app, engineering staff and
   `cloudComputerV2`. Run `pnpm smoke:engine` on that Mac separately.
4. Use two Mac devices with distinct staff owner/developer accounts. Also have
   prompter/viewer accounts to check denied editing authority. Create ordinary
   disposable workspaces through C5, named `zeros-v2-test-native-previews-a`
   and `zeros-v2-test-native-previews-b`. Use the same approved template.
5. Record privately: app/source revisions, runtime/base/template IDs, workspace
   and generation IDs, engine-instance IDs, device IDs/key versions, each test
   grant ID and its expiry. Record time and closed pass/fail categories. Never
   copy capability headers, bearer URLs, private keys, account tokens or raw
   provider responses into reports, screenshots, console output or PRs.

## Human and agent applications

Use the template's existing dev application and installed command; E2 does not
install dependencies or change template/setup/persistence behavior. Run it on
an allowed app port such as 5173 with a visible `human-a` marker, static assets,
an application cookie, a nested route and working HMR. Choose a cookie fixture
that contains no account/session material. Keep a second app with an
`agent-a` marker in an agent boundary. Its requested display port should also
be 5173; the trusted engine owns its real mapped listener.

1. Start the human application from the cloud terminal. Type its
   `http://localhost:5173/` URL in Browser. Open its detected Run preview too.
   Require the `human-a` marker, correct assets and nested route/query string,
   cookie roundtrip and a successful asset edit/HMR update without reload.
   No Mac loopback application may answer these navigations.
   From an empty Browser tab, enter another allowed loopback port. Change the
   address in an admitted tab and use Back, Forward and Reload. Require fresh
   native admission before navigation and zero Mac loopback requests throughout.
   Follow an application link and use SPA navigation to change path/query/hash.
   Require the updated logical address and working Back/Forward without changing
   opaque ownership or minting grants for the page-originated moves. Follow an
   external link; require its URL to persist and Reload to stay on that page
   without issuing a preview grant. Repeat these checks in the agent preview.
2. Ask a real cloud agent to start the second application. Open its published
   listener button, then a loopback link from that same agent transcript.
   Require `agent-a`, assets, cookie roundtrip, nested path and actual HMR.
   The human page must continue showing `human-a` despite equal display ports.
   The diagnostic snapshot/Browser state must contain only opaque execution
   and listener identity, logical URL and display port, never actual coordinates.
3. Run a second agent app at that display port with `agent-b`. Open both
   listeners. Existing tabs must not switch application or execution authority.
   Terminate the first listener and restart it at the same requested port.
   Its old tab must reject the retired ID; opening the newly published listener
   must succeed with a fresh admission. Record both IDs privately.
4. Attempt 22222, the configured runtime engine/service ports, a port below
   1024 and an invalid port. Admission must fail before application connection.
   Reuse E1's [TCP acceptance](native-access-acceptance.md) for non-HTTP
   forwarding and Mac listener collisions; E2 does not change that transport.

## Frame, account and device ownership

1. Copy a preview origin into an unauthenticated external browser and request an
   asset and WebSocket upgrade. Require denial. An ordinary renderer fetch,
   sibling Browser iframe, or embedded child calling the preview IPC must not
   acquire the owning frame's capability. Inspect only whether the private
   header is present; never copy or log its value.
2. With network throttling delaying admission, close the tab; repeat while
   replacing its iframe, switching workspace A → B → A, and switching account.
   Release the delayed request. The old result must neither navigate the new
   frame nor revoke its successor. Confirm the retired grant by ID and that no
   pending orphan grant remains active. Reopen through ordinary UI if needed.
3. Keep a preview visible across its renewal deadline. Require a fresh grant and
   successful HTTP/assets/HMR using the same opaque listener. Hide the tab, then
   hide the app; both must retire the frame grant and stop renewal. Wait past the
   original 30-minute expiry. Showing the tab must re-admit its exact owner;
   a hidden iframe must not mint grants, wake a workspace or poll listeners.
4. Open the same human and agent app on both devices. Close one tab or revoke
   its grant by ID using existing access administration. That device's HTTP/HMR
   must cease within the runtime's ≤10-second authority lease; the other
   independently issued grant must keep working. Revoke or rotate the first
   device through the existing device-management flow: its former grants must
   fail on public ingress and runtime renewal even if its app stays open.
5. Disable `cloudComputerV2`, sign out, and remove editing access in separate
   runs. New admissions must be refused and active authority retired/denied.
   Prompter/viewer accounts must not gain edit authority through a copied URL,
   forged target or direct native request. Re-enable/re-enroll only through
   normal staff/account/device flows; prior grants must not regain authority.
   Remove or withhold the exact workspace capability snapshot too. Browser,
   Run and agent previews must retire authority and stop admission/retry work;
   editing permission on a different workspace must not authorize this one.
   A native scalar API request omitting `native` and `target` must still require
   trusted device proof, and old unbound native grants must be denied.

## Wake and cleanup

1. Close test previews and services. Stop/wake one workspace through the normal
   lifecycle, consuming B8/B10 receipts and confirming unchanged accepted
   runtime/base/template pins and preserved app files. Restart the human app,
   then open Browser/Run: require a fresh admission, assets and HMR. Start a new
   agent listener and open its newly published ID. A former execution's tab
   must not attach itself to a replacement listener by display port.
2. Stop every fixture app/agent, close all preview tabs and E1 forwards on both
   devices, revoke remaining test grants and remove disposable device enrollment
   if created for this run. Delete both test workspaces through normal Alpha UI
   and wait for confirmed resource cleanup. Do not delete the shared template,
   approved base or runtime artifacts owned by C5/B8/B10.
3. Report every created workspace/provider resource/device/grant ID privately
   with its cleanup outcome, plus exact app/runtime revisions and each failed
   acceptance case. Any incomplete cleanup or prerequisite is a failed or
   pending result, never a parity claim.

Local implementation verification covers opaque target resolution, stale and
reserved listeners, HTTP/HMR renewal, device proof/rotation/revocation, separate
same-port tabs, frame replacement, hidden expiry and stale workspace responses.
Browser smoke uses synthetic native I/O. It does not qualify Chromium/Electron
header injection, live Boat templates, Mac device flows or wake/persistence.
