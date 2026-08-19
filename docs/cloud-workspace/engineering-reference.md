# Cloud workspace engineering reference

## Current implementation status

| Capability                                         | Status                                                    | Current anchor                                                                         |
| -------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Remote engine HTTP/WebSocket transport             | Implemented, opt-in and non-production                    | `apps/desktop/src/engine/transport/cloud.ts`                                           |
| Engine activation                                  | Implemented when `ZEROS_CLOUD_PORT` is a positive integer | `apps/desktop/src/engine/zeros-engine.ts`                                              |
| Transport unit tests                               | Implemented                                               | `apps/desktop/src/engine/transport/__tests__/cloud-transport.test.ts`                  |
| Provider image/lifecycle validation                | Implemented as an operator harness + protected manual CI  | `scripts/cloud-workspace-validation/`, `.github/workflows/zsr-cloud-qualification.yml` |
| Shared bridge protocol/version                     | Implemented                                               | `packages/protocol/`                                                                   |
| Team identity and authorization foundation         | Implemented for existing product APIs                     | `apps/control-plane/`                                                                  |
| Production workspace registry and lifecycle API    | Implemented, gated, and pre-production                    | `apps/control-plane/migrations/0010_cloud_workspace_control_plane.sql`, `apps/control-plane/src/cloud-workspaces/` |
| Provider reconciliation and orphan recovery        | Implemented; live provider qualification still required  | `apps/control-plane/src/cloud-workspaces/reconciler.ts`, `daytona-provider.ts`          |
| Production setup worker and workspace engine grant | Not implemented                                           | Phase 2 in `implementation-roadmap.md`                                                  |
| Production desktop remote client and management UI | Not implemented                                           | Future desktop engine/renderer feature ownership                                       |
| Durable cloud-workspace record/write-through       | Not implemented                                           | Future control-plane/data-plane work                                                   |
| Web/mobile management                              | Not implemented                                           | Future `apps/web`, then real mobile app boundaries                                     |

## Existing environment contract

The validation foundation recognizes:

- `ZEROS_CLOUD_PORT`: enables the engine's additional remote listener;
- `ZEROS_CLOUD_TOKEN`: mandatory bounded capability gating the Zeros WebSocket
  upgrade in the validation boundary;
- `ZEROS_ACCOUNT_JWT_*`, `ZEROS_REQUIRE_ACCOUNT`, and
  `ZEROS_CLOUD_OWNER_SUB`: required asymmetric owner binding for an attested
  cloud worker; and
- validation-only provider variables documented in
  [`scripts/cloud-workspace-validation/README.md`](../../scripts/cloud-workspace-validation/README.md).

These names are externally observable bootstrap contracts. Do not rename them
without compatibility handling. The bridge capability remains defense in
depth; a production connection grant must add workspace/tenant/purpose binding,
and that transition must be explicit and tested.

The production control plane additionally recognizes the explicitly gated
`CLOUD_WORKSPACES_ENABLED` block documented in
`apps/control-plane/.env.example`. Credentials alone never enable creation.
The configured image, architecture, source commit, CPU, memory, and storage are
recorded per generation and passed through the provider boundary. Public API
documents use the stable Zeros workspace id and never expose provider resource
ids. A system operator must provision an Organization quota before any create
request can succeed.

## Protocol contract

Remote clients use `PROTOCOL_VERSION` from `packages/protocol/src/version.ts`.
Wire-shape changes require the protocol guard and mixed-version behavior. The
validation client imports the shared version rather than duplicating a numeric
constant.

## Security boundary already preserved

`LocalTransport` remains loopback-only with local host/origin defenses.
`CloudTransport` is a separate listener behind a remote network boundary; cloud
work must never relax local transport checks. The current bridge token is kept
out of the validation URL, and harness state is written atomically with
owner-only permissions and removed after successful cleanup. The browser and
operator clients use the same safe `zeros-v1` + credential-carrier protocol and
the shared canonical `source: "browser"` discriminator; the client forces that
value so a call site cannot produce a connected-but-discarded false green.

The listener enforces aggregate—not merely per-socket—handler and retained-byte
limits, preserves a separately bounded control lane, and bounds total outbound
buffering and HTTP/WS connection/shutdown state. Qualified account verification
coalesces JWKS lookups, has fetch and streamed-body deadlines/caps, validates
key-use/algorithm metadata, and cannot fall back to symmetric signing.

## Useful commands

```bash
pnpm exec vitest run apps/desktop/src/engine/transport/__tests__/cloud-transport.test.ts
pnpm exec vitest run scripts/__tests__/cloud-bridge-client.test.ts
pnpm exec vitest run scripts/__tests__/cloud-workspace-validation-config.test.ts
pnpm exec vitest run scripts/__tests__/repository-layout.test.ts
pnpm build:engine
pnpm check:protocol
pnpm check:secrets
pnpm --dir apps/control-plane audit:prod
```

The provider-account sequence is documented beside the harness. It is never a
fork/PR-CI claim. The protected manual workflow uses exact-commit image builds,
an ephemeral asymmetric validation identity, required live
Claude/Codex/Cursor turns with a per-turn challenge, the same browser-safe WSS
credential carrier as the renderer, outbound-reachability/soak/SSH verdicts, and
fresh-inventory-verified resource cleanup. A workflow existing in source is not
evidence that it ran: record platform, region, image ID, runtime versions,
measured latencies, soak duration, cleanup result, and sanitized failures in
the private operational record.

## Ownership rules

- Keep lifecycle schemas and routes in `apps/control-plane`, not in desktop UI.
- Put remote desktop connection orchestration in a semantic cloud-workspace
  feature/engine boundary, not in `renderer/shared`.
- Keep provider SDK types behind the control-plane/provider boundary.
- Add a shared package only after a stable contract has multiple deployable
  consumers.
- Add a new app only when it owns an independent build and deployment.
- Update this reference and `REPOSITORY-ARCHITECTURE.md` whenever those
  boundaries become real.
