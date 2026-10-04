# Native SSH and TCP forwarding: Mac Alpha acceptance

This is the E1 live acceptance procedure for the orchestrator. Run it on a signed
Zeros Alpha Mac build against Alpha/test workspaces only. Linux OpenSSH tests and
the browser fixture establish local integration, not this combined qualification.
Browser/agent previews, IDE integrations, file sync and lifecycle implementation
are outside E1.

## Prerequisites and evidence

1. Qualify C5 template forks/projections, B8 accepted runtime pins across wake,
   and B10 persistence mounts before this procedure. Use a fresh qualified v4 base
   and sanitized Cloud Computer template. Verify the ordinary fork's primary and
   secondary repository revisions and engine admission. Retain the actual B10
   mount/machine-id receipts; older persistence experiments are not substitutes.
2. The Mac build includes the `cloudComputerV2` Internal toggle and E5's
   server-derived `capabilities.canEdit`. Enable that toggle as staff. Use owner,
   manager/developer, prompter and viewer fixtures, with two separately registered
   Mac devices. Missing `canEdit` must disable the access controls.
3. Name disposable workspaces/templates and remote test directories with
   `zeros-v2-test-`. Record app commit/version, runtime/base/template revisions,
   workspace/generation, device IDs and created provider resource IDs in a private
   receipt. Record pass/fail and cleanup for every row below. Do not record
   capability values, account tokens, private keys, full process arguments or
   environment dumps. Do not paste the copied command/config into the PR.
4. Prepare/clean provider resources through the orchestrator's existing Alpha
   scripts in its credentialed workspace. The Mac steps below use the signed
   desktop's credentials and native actions; no provider administration SSH,
   direct provider tunnel, credentials copied through chat, or `.env.agent`
   copied onto the Mac is needed. No Beta/Production operation is part of this
   procedure.

Opening the cloud-details popover warms safe metadata only. Network inspection
must record method/path/status or header **names**, never header/body values.
Actual access uses `POST .../runtime/services` and the control-plane WSS relay,
not the legacy `/ssh` or `/tunnels` routes. A service grant lasts 15 minutes.

## SSH and SFTP

For each scripted connection, choose **Copy SSH command** afresh. Its form is
`/usr/bin/ssh -F '<private-config-path>' zeros-cloud`. Set `ssh_config` manually
to that path, preserving quotes/spaces; do not evaluate clipboard text. The path
is local metadata, not a bearer, but is ephemeral and should remain private.
Keep Zeros Alpha running. A command is single-use, including failed handshakes.

| Case | Action | Required result |
| --- | --- | --- |
| Delayed copy | Copy a command, wait at least 15 seconds, then use it before its 15-minute expiry. | Shell opens without a host-key prompt. Copying did not start the remote SSH handshake deadline. |
| Terminal | Choose Open Terminal; run `id -u`, `pwd`, and `stty size`. Resize that Terminal and run `stty size` again. | UID 10001, selected primary checkout, dimensions follow the window. No provider-admin credential path. |
| Exec | Run the command below with a fresh config. | Separate stdout/stderr and exit status 17. |
| SFTP | Run the file roundtrip below with another fresh config. | Identical downloaded bytes; ordinary workload file permissions. |
| One use | Try the consumed command again. | Fails. A newly copied command works with fresh key trust. |
| Pin mismatch | Point a fresh command at an unrelated valid known-hosts entry as below. | Host-key verification fails before the remote command runs; no fallback. |
| Environment | With a fresh config, use `-o SetEnv=ZEROS_E1_PROBE=present` and remote command `test "${ZEROS_E1_PROBE-unset}" = unset`. | Exit 0; client environment injection was refused. |
| Agent | With a local ssh-agent available, use `-A` and remote command `test -z "${SSH_AUTH_SOCK-}"` on a fresh config. | Exit 0; no forwarded agent socket in the workload. Do not print socket/environment values. |
| SSH forwarding | With a fresh config, use `-o ClearAllForwardings=no -W 127.0.0.1:44173`. | Direct TCP channel is rejected even while the test listener below is running. A separate tunnel grant is required. |

Exec (on the Mac; `ssh_config` names a newly copied config):

```sh
/usr/bin/ssh -F "$ssh_config" zeros-cloud 'printf "out\n"; printf "err\n" >&2; exit 17'
test "$?" -eq 17
```

SFTP (create `zeros-v2-test-e1` in the workspace's primary directory first,
using its ordinary Zeros terminal):

```sh
e1_local_dir=$(mktemp -d /tmp/zeros-v2-test-e1.XXXXXX)
printf 'zeros-v2-test-e1 file roundtrip\n' > "$e1_local_dir/source"
printf 'put %s zeros-v2-test-e1/upload\nget zeros-v2-test-e1/upload %s\nrm zeros-v2-test-e1/upload\nbye\n' \
  "$e1_local_dir/source" "$e1_local_dir/download" > "$e1_local_dir/batch"
/usr/bin/sftp -b "$e1_local_dir/batch" -F "$ssh_config" zeros-cloud
cmp "$e1_local_dir/source" "$e1_local_dir/download"
```

Mismatch (another fresh config; retain only pass/fail):

```sh
/usr/bin/ssh-keygen -q -t ed25519 -N '' -f "$e1_local_dir/wrong-host"
awk '{ print "zeros-cloud " $1 " " $2 }' "$e1_local_dir/wrong-host.pub" > "$e1_local_dir/wrong-hosts"
/usr/bin/ssh -F "$ssh_config" -o "UserKnownHostsFile=$e1_local_dir/wrong-hosts" \
  zeros-cloud 'touch zeros-v2-test-e1/must-not-exist'
```

Expect a nonzero exit and host-key verification failure. In the ordinary Zeros
terminal, `test ! -e zeros-v2-test-e1/must-not-exist` must succeed. Re-copy after
each negative case; do not weaken StrictHostKeyChecking to make it pass.

## TCP forwarding

In the workspace's ordinary human terminal, start a binary echo listener:

```sh
node -e 'require("node:net").createServer(socket => socket.pipe(socket)).listen(44173, "127.0.0.1")'
```

In cloud details enter Workspace port **44173**, Mac port **45173**, then
**Forward port**. Run this on the Mac:

```sh
python3 - <<'PY'
import socket
payload = bytes([0, 255, 13, 10]) * 8192
with socket.create_connection(("127.0.0.1", 45173), timeout=5) as client:
    client.sendall(payload)
    received = bytearray()
    while len(received) < len(payload):
        chunk = client.recv(65536)
        if not chunk:
            raise SystemExit("FAIL: truncated TCP response")
        received.extend(chunk)
    if received != payload:
        raise SystemExit("FAIL: TCP bytes changed")
print("PASS: native binary TCP roundtrip")
PY
lsof -nP -iTCP:45173 -sTCP:LISTEN -Fn
```

The listener must be `127.0.0.1:45173`, with no wildcard or LAN binding. Open
several simultaneous local connections and verify isolation. Test these cases:

- Request another forward on 45173. It must report a collision, preserve the
  first forward, and retire the failed attempt's grant. Choose 45174 to open a
  second independent forward; closing one must leave the other working.
- Remote ports 1023, 22222, 39393 and 65536 must be rejected. Also exercise the
  deployment's configured reserved service/engine ports. No listener or grant
  may survive rejected admission except a visible **Retry close** when cleanup
  cannot reach the control plane.
- Stop the echo server and try a new local connection. Rejected upstream
  admission must close the local forward; restarting the server requires an
  explicit **Forward port** action. There is no silent grant renewal.
- Repeat with two registered Mac devices. Close an A grant and check B's SSH
  and tunnel still work. Revoking device A must end A's established streams
  within the backend's ten-second authority deadline and reject its unused
  commands; device B remains usable. Rotate a device key and repeat with the
  old key's handles. Re-enrollment must not revive them.

## Lifecycle, renderer and cleanup

1. Close a Terminal window during a live session. Its access row must disappear
   after successful exact-grant DELETE; no unexpired grant should block idle
   just because that window was closed. Test a detached descendant by starting
   this in the SSH shell, leaving the shell open initially:

   ```sh
   setsid sh -c 'while :; do printf . >> zeros-v2-test-e1/detached; sleep 1; done' </dev/null >/dev/null 2>&1 &
   ```

   Use the separate ordinary Zeros terminal to observe the file grow. Close the
   SSH window (then repeat with explicit revoke). After retirement, sample
   `wc -c zeros-v2-test-e1/detached` twice at least three seconds apart. It must
   stop growing. This validates the actual v4 PID namespace, not only local
   OpenSSH behavior.
2. Leave a copied command unused until its 15-minute expiry. It must fail and
   its local files/access row must be retired. An established SSH or tunnel
   also closes at expiry. Obtain a new grant to reconnect.
3. Switch workspaces/tabs A → B → A. Rows and actions must remain scoped to
   their original workspace, with no read flicker or capability in renderer
   state. Hiding/closing the popover does not close deliberate Terminal/TCP
   access, and does stop metadata polling. Revalidation retains same-key rows.
   Prompters/viewers must not open access; turn off the Internal toggle and
   confirm the entire new surface disappears.
4. Change accounts while admission is pending and while streams are active.
   Old local listeners close; late results cannot copy/launch into the new
   account. Only the issuing account is used for remote cleanup. Disconnect
   networking before a Close or before failed-bind cleanup, then reconnect:
   **Retry close** must retire that exact grant without closing a sibling.
5. Close every grant, stop the workspace through its authorized lifecycle,
   and wake it after the prerequisite owners have qualified that path. Old
   commands/listeners must not work or reopen automatically. Fresh explicit
   admission must work with current runtime identity and a new SSH pin. Verify
   no local file or restored provider filesystem was treated as a surviving
   service grant. Repeat the TCP roundtrip. Record accepted runtime/base pins
   before/after for B8; do not change their implementation in E1.
6. Close every remaining access row on both devices; stop the echo server;
   remove only the created `zeros-v2-test-e1` remote directory and the exact
   `$e1_local_dir` on the Mac. Verify both local ports are unbound and normal
   successful-close config/socket directories are absent. The orchestrator
   deletes every created workspace/template/provider resource using its Alpha
   cleanup workflow and records each resource ID and verified result. If a
   remote cleanup cannot be confirmed, mark the run incomplete; do not claim
   expiry as successful explicit cleanup.

## Local automated evidence

The client/transport/broker/IPC suites cover strict admission, introduction and
key mismatch, expiry, stale account/device responses, exact-grant cleanup,
loopback collision and final-byte preservation. Native OpenSSH exec/SFTP tests
require system `ssh`, `nc` with Unix-socket support, and `sftp`; SFTP finds the
platform's installed `sftp-server` and explicitly skips that test if absent.
The engine suites exercise SSH restrictions and human-service authority; the
control-plane `runtime-services.integration` suite requires a disposable local
`TEST_DATABASE_URL` and exercises old epoch/device and two-device revocation.
The UI smoke uses synthetic native I/O and verifies gated actions, retained
metadata, exact context, close isolation and hidden-view polling. No local test
qualifies Terminal.app, signed packaging, the v4 PID namespace or live wake.
