import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(),
  withSystemTx: async (_pool: unknown, run: (tx: unknown) => unknown) => run({ query: mocks.query }),
}));
import { CloudCommandSettleSchema, DatabaseCloudWorkspaceCommandService,
  CLOUD_COMMAND_FAILURE_STAGES, CLOUD_COMMAND_FAILURE_CATEGORIES, CloudNativeResultSchema,legacyCloudCommandResponse } from "./commands.js";
import { CLOUD_COMMAND_FAILURE_STAGES as WireStages, CLOUD_COMMAND_FAILURE_CATEGORIES as WireCategories,
  encodeCloudCommandFailure,CloudNativeResultSchema as WireNativeResult,legacyCloudCommandResponse as wireLegacyCloudCommandResponse} from "../../../../packages/protocol/src/cloud-commands.js";

it("mirrors old native-v1 terminal projections without discarding other native fields",()=>{
  const terminal={commandId:randomUUID(),conversationId:"conversation",executionId:"execution",turnId:"turn",agentId:"claude",status:"completed",stopReason:"end_turn"};
  const result={version:1,model:"qualified-model",terminal},entry={result,payload:{operation:{version:1,kind:"goal",action:"get"}}};
  const snapshot={nativeGoal:{version:1},pending:[entry,{result:null}],receipts:[entry]};
  const oldResult=CloudNativeResultSchema.omit({terminal:true});
  for(const input of [null,[],{},entry,snapshot])for(const version of [undefined,1] as const)
    expect(legacyCloudCommandResponse(input,version)).toEqual(wireLegacyCloudCommandResponse(input,version));
  const projected=legacyCloudCommandResponse(entry,1) as typeof entry;
  expect(projected.result).toEqual(oldResult.parse({version:1,model:"qualified-model"}));expect(projected.payload).toEqual(entry.payload);
  const projectedSnapshot=legacyCloudCommandResponse(snapshot,1) as typeof snapshot;
  expect(projectedSnapshot.nativeGoal).toEqual(snapshot.nativeGoal);expect(projectedSnapshot.pending[0]).toEqual(projected);expect(projectedSnapshot.receipts[0]).toEqual(projected);
  expect(snapshot.pending[0]!.result).toHaveProperty("terminal",terminal);
});

describe("cloud command safe cause storage", () => {
  it("mirrors bounded terminal receipts and preserves every exact terminal field",()=>{
    const terminal={commandId:randomUUID(),conversationId:"conversation",executionId:"execution",turnId:"turn",agentId:"claude",status:"failed",stopReason:"blocking_limit",
      response:{stopReason:"blocking_limit",effectiveModel:"claude-haiku-4-5",usage:{inputTokens:7,outputTokens:3,totalCostUsd:0.01}},
      failure:{kind:"rate-limited",message:"Synthetic usage limit",stage:"prompt"},startedAt:1,endedAt:2};
    expect(CloudNativeResultSchema.parse({version:1,terminal})).toEqual({version:1,terminal});
    expect(CloudCommandSettleSchema.parse({commandId:terminal.commandId,claimId:randomUUID(),state:"failed",resultCode:"cloud_provider_prompt_rate_limited",result:{version:1,terminal}}).result?.terminal).toEqual(terminal);
    for(const value of [terminal,{...terminal,commandId:undefined},{...terminal,status:"unknown"},{...terminal,response:{...terminal.response,usage:{inputTokens:-1}}},
      {...terminal,response:{...terminal.response,usage:{perModel:Array.from({length:33},()=>({model:"model"}))}}},{...terminal,failure:{...terminal.failure,private:"excluded"}},
      {...terminal,error:"x".repeat(8001)}]){
      expect(CloudNativeResultSchema.safeParse({version:1,terminal:value}).success).toBe(WireNativeResult.safeParse({version:1,terminal:value}).success);
    }
  });
  it.each(["executor_start_failed", "provider_login_failed", "environment_setup_failed", "environment_identity_mismatch", "environment_not_ready",
    "credential_refresh_invalid", "credential_refresh_timeout", "credential_refresh_unchanged", "credential_refresh_rejected", "lock_busy", "execution_limit",
    "customization_changed", "access_denied", "environment_revoked", "environment_runtime_required", "environment_unavailable", "lease_expired"])("accepts the closed %s receipt", category => {
    const input={commandId:randomUUID(),claimId:randomUUID(),state:"failed",resultCode:`cloud_validation_${category}`};
    expect(CloudCommandSettleSchema.parse(input)).toEqual(input);
  });
  it("keeps the reserved cause vocabulary in parity without importing protocol into production", () => {
    expect(CLOUD_COMMAND_FAILURE_STAGES).toEqual(WireStages);
    expect(CLOUD_COMMAND_FAILURE_CATEGORIES).toEqual(WireCategories);
    for (const stage of WireStages) for (const category of WireCategories) {
      const input = { commandId: randomUUID(), claimId: randomUUID(), state: "failed", resultCode: encodeCloudCommandFailure({ stage, category }) };
      expect(CloudCommandSettleSchema.parse(input)).toEqual(input);
    }
    expect(CloudCommandSettleSchema.safeParse({ commandId: randomUUID(), claimId: randomUUID(), state: "failed",
      resultCode: "cloud_provider_prompt_private_diagnostic" }).success).toBe(false);
  });
  it("writes and replays the exact code while retaining a proved admission denial", async () => {
    const commandId = randomUUID(), claimId = randomUUID(), engineInstanceId = randomUUID(), workspaceId = randomUUID();
    const scope = { workspaceId, organizationId: randomUUID(), generation: 1, engineInstanceId, heartbeatToken: "zwh_fixture" };
    const row = { id: commandId, claim_id: claimId, engine_instance_id: engineInstanceId, generation: 1,
      conversation_id: "chat", state: "dispatching", result_code: null as string | null, result: null };
    mocks.query.mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.startsWith("UPDATE cloud_workspace_commands")) { row.state = String(args[2]); row.result_code = args[3] as string; }
      return { rows: [row] };
    });
    const service = new DatabaseCloudWorkspaceCommandService({ pool: {} as never });
    Object.assign(service, { authorize: async () => {}, control: async () => ({ revision: 1 }), bump: async () => {},
      view: async () => ({ receipts: [{ resultCode: row.result_code }] }) });
    const result = { commandId, claimId, state: "failed" as const, resultCode: "cloud_containment_canary_failed" };
    expect(await service.settle(scope, result)).toMatchObject({ receipts: [{ resultCode: result.resultCode }], replayed: false });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("SET state=$3,result_code=$4"),
      [workspaceId, commandId, "failed", result.resultCode, null]);
    expect(await service.settle(scope, result)).toMatchObject({ receipts: [{ resultCode: result.resultCode }], replayed: true });
    row.state = "dispatching"; row.result_code = "cloud_agent_model_not_authorized";
    expect(await service.settle(scope, result)).toMatchObject({ receipts: [{ resultCode: "cloud_agent_model_not_authorized" }] });
  });
});
