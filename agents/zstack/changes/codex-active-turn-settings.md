# Codex runtime parity and active-turn settings

Symptom: a mechanical Codex bump advanced Local while leaving the standalone
worker on the previous version. Effort/Fast picker changes updated only the
next turn, even though 0.165.0 enables native effort updates for supported
models. Cloud did not route the existing config courier.

Cause: the pin gate covered the Local binary/generated protocol but not the
worker manifest, and configuration handling stopped at the saved env. A first
live-update implementation also lost same-tick changes by leaving a completed
flush promise installed through a later microtask. Cloud snapshots could race
driver opening or omit a separate model-selection courier.

Rule: qualify interactive runtime pins in both placements. Keep next-turn
configuration and exact-active-turn publication separate. Serialize/coalesce
settings against the original prompt, runtime and native turn; fence terminal
ACKs, completion, Stop and replacement before dispatch. Clear a flush promise
inside the pass before it resolves. Bypass generic transport retries that cannot
recheck the turn after backoff. A native refusal or lost settings reply
cannot abort inference, and a model switch's remembered knobs must wait for
that model's next turn. Complete cloud snapshots carry the model and persist
before applying typed selections to a ready driver.

Encoding: `scripts/check-codex-pin.mjs` now checks cloud/Local manifest equality,
with missing, ranged and mismatched pin regressions. Local
`app-server-adapter-settings.test.ts`, cloud `settings.test.ts`, the real
JSON-RPC driver fixture and worker routing tests cover live changes, same-tick
ACK/no-op races, serialized updates, refusal/timeout, exact-turn retirement,
model snapshots and reopen persistence. Eval cases `codex-active-turn-settings`,
`cloud-codex-active-turn-settings` and `codex-cloud-pin-parity` retain the checks.

Catalog lesson: inspect the pinned native catalog and a complete `model/list`
response. Terra advertises Ultra as well as the five initially listed efforts,
and Fast. Native Low and curated Max defaults are different policies; preserve
the requested curated Sol policy and existing aliases/favorites. The catalog
regression pins all six efforts, order, default and Fast support.

Verification lesson: a checkout created with a group-writable umask can leave
an executable at 0775 even though Git records 100755. Starting tests with
`umask 022` does not change existing files. The existing packaging contract
caught this for `scripts/ci/with-userns.sh`; restore its 0755 permissions and
rerun the test instead of weakening the assertion or changing Git's mode.
