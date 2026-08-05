# Cloud workspace engineering reference

## Current implementation status

| Capability                                         | Status                                                    | Current anchor                                                        |
| -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Remote engine HTTP/WebSocket transport             | Implemented, opt-in and non-production                    | `apps/desktop/src/engine/transport/cloud.ts`                          |
| Engine activation                                  | Implemented when `ZEROS_CLOUD_PORT` is a positive integer | `apps/desktop/src/engine/zeros-engine.ts`                             |
| Transport unit tests                               | Implemented                                               | `apps/desktop/src/engine/transport/__tests__/cloud-transport.test.ts` |
| Provider image/lifecycle validation                | Implemented as an operator harness                        | `scripts/cloud-workspace-validation/`                                 |
| Shared bridge protocol/version                     | Implemented                                               | `packages/protocol/`                                                  |
| Team identity and authorization foundation         | Implemented for existing product APIs                     | `apps/control-plane/`                                                 |
| Production workspace registry and lifecycle API    | Not implemented                                           | Future `apps/control-plane/` migrations/routes/services               |
| Production desktop remote client and management UI | Not implemented                                           | Future desktop engine/renderer feature ownership                      |
| Durable cloud-workspace record/write-through       | Not implemented                                           | Future control-plane/data-plane work                                  |
| Web/mobile management                              | Not implemented                                           | Future `apps/web`, then real mobile app boundaries                    |

## Existing environment contract

The validation foundation recognizes:

- `ZEROS_CLOUD_PORT`: enables the engine's additional remote listener;
- `ZEROS_CLOUD_TOKEN`: gates the Zeros WebSocket upgrade in the validation
  boundary; and
- validation-only provider variables documented in
  [`scripts/cloud-workspace-validation/README.md`](../../scripts/cloud-workspace-validation/README.md).

These names are externally observable bootstrap contracts. Do not rename them
without compatibility handling. Production connection grants may supersede a
shared token, but the transition must be explicit and tested.

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
owner-only permissions and removed after successful cleanup.

## Useful commands

```bash
pnpm exec vitest run apps/desktop/src/engine/transport/__tests__/cloud-transport.test.ts
pnpm exec vitest run scripts/__tests__/cloud-workspace-validation-config.test.ts
pnpm exec vitest run scripts/__tests__/repository-layout.test.ts
pnpm build:engine
pnpm check:protocol
pnpm check:secrets
```

The provider-account sequence is documented beside the harness and is not a
public-CI claim. Record platform, region, image ID, runtime versions, measured
latencies, soak duration, cleanup result, and sanitized failures in the private
operational record.

## Future ownership rules

- Put lifecycle schemas and routes in `apps/control-plane`, not in desktop UI.
- Put remote desktop connection orchestration in a semantic cloud-workspace
  feature/engine boundary, not in `renderer/shared`.
- Keep provider SDK types behind the control-plane/provider boundary.
- Add a shared package only after a stable contract has multiple deployable
  consumers.
- Add a new app only when it owns an independent build and deployment.
- Update this reference and `REPOSITORY-ARCHITECTURE.md` whenever those
  boundaries become real.
