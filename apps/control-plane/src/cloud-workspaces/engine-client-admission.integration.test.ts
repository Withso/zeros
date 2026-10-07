import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH,
  DatabaseCloudWorkspaceEngineClientAdmissionService,
} from "./engine-client-admission.js";

function fixture() {
  const connect = vi.fn(async () => { throw new Error("Database must not be contacted for retired actor admission"); });
  const service = new DatabaseCloudWorkspaceEngineClientAdmissionService({
    pool: { connect } as unknown as pg.Pool,
    endpoint: `https://api.example.test${CLOUD_WORKSPACE_ENGINE_CLIENT_ADMISSION_PATH}`,
    enginePort: 39393,
    relayEnabled: true,
  });
  return { service, connect };
}
const scope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  actorUserId: "33333333-3333-4333-8333-333333333333",
};
const refusal = { code: "cloud_workspace_client_update_required", message: "Update Zeros to connect to cloud workspaces." };

describe("retired actor-protocol-1 engine admission", () => {
  it("tells an older desktop to update before device or grant admission", async () => {
    const { service, connect } = fixture();
    await expect(service.issue(scope)).rejects.toMatchObject(refusal);
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([false, true])("refuses redemption and renewal (renew=%s) of historical grants", async renew => {
    const { service, connect } = fixture();
    await expect(service.consume({ ...scope, generation: 1, engineInstanceId: scope.actorUserId,
      token: `zws_${"A".repeat(43)}`, heartbeatToken: `zwh_${"B".repeat(43)}`, renew })).rejects.toMatchObject(refusal);
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([false, true])("never opens or retains an old grant relay (connected=%s)", async connected => {
    const { service, connect } = fixture();
    expect(await service.authorizeRelay(`zws_${"A".repeat(43)}`, { connected })).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });
  it("keeps trusted device admission mandatory for modern actors", async () => {
    const { service, connect } = fixture();
    await expect(service.issueActor({ ...scope, authenticatedUser: undefined as never })).rejects.toMatchObject({
      code: "engine_client_admission_invalid", message: "A trusted device is required for actor admission",
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
