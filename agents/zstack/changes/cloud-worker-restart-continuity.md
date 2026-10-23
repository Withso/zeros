# Cloud worker restarts must be invisible to the app

- Idle stop then wake restarts the worker every time: the wake rotates its
  token and runs `systemctl restart`. Anything the app holds across that cycle
  must survive a new worker process: chat executions, terminal identity, and
  pending requests. Test every app-held identifier with the worker harness's
  `restart()`, not only with a reconnect, and run the live stop→wake→continue
  probe on the same chat.
- Persist a route identity only alongside its fence. A restarted worker may
  re-adopt a chat's current execution, but never one the chat replaced or the
  user closed. Graceful shutdown keeps the id; a user close retires it. Probes
  such as adoptOnly loads must still miss, so a reconnect never starts a
  native process.
- The cloud engine identity must change with the worker process. A per-workspace
  constant makes every renderer path for a replaced engine (keep the tabs,
  respawn the shells) dead code for cloud. The app instead drops tabs as if
  another device had closed them.
- When a fix is about a native boundary, test that boundary. node-pty replaces
  `PWD` with the spawn cwd, so a fake spawner that only checked the env passed
  while the real prompt still showed `/proc/<pid>/fd/<n>`. A real PTY test
  caught it.
- Treat "the provider no longer has it" as final. A 404 from Boat for the VM,
  or an expired disk, cannot be fixed by retrying resume or stop for 15 minutes.
  Fail at once with a named reason the app explains.

Encoded in worker `agents-rebind.test.ts` (a worker restart),
`terminals/__tests__/terminal.test.ts` (real shell), renderer
`workspace-runtime-client.test.ts` and `ws-client-passive-read.test.ts`, and
control-plane `lifecycle.test.ts`. Live:
`~/.zeros-ops/v2/checks/wake-continue.mjs` and `vanished-vm.mjs`.
