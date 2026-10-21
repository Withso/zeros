import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CloudAgentConnectionHealthSchema } from "../cloud-agent-connection-health";
import { CloudAgentConnectionHealthSchema as Backend } from "../../../../apps/control-plane/src/agent-credentials/agent-connection-health-contract";

const observedAt="2026-10-15T11:00:00.000Z";
const ready={version:1,status:"ready",observedAt,selectedCredentialRevision:2,credentialRevision:2,
  materialVersion:6,expiresAt:"2026-10-15T12:00:00.000Z",refresh:"idle"};
const parsers=[CloudAgentConnectionHealthSchema,Backend];
describe("selected account health wire parity",()=>{
  it.each([
    ready,
    {...ready,expiresAt:null,refresh:"not_applicable"},
    {...ready,status:"expired",expiresAt:"2026-10-15T10:00:00.000Z",refresh:"reconnect_required"},
    {...ready,status:"expired",expiresAt:"2026-10-15T10:00:00.000Z",refresh:"in_progress"},
    {...ready,status:"expiring",expiresAt:"2026-10-15T11:00:20.000Z",refresh:"reconnect_required"},
    {...ready,status:"credential_changed",credentialRevision:3,materialVersion:7,refresh:"unavailable"},
    {...ready,status:"consent_required",refresh:"unavailable"},
    {...ready,status:"credential_unavailable",credentialRevision:null,materialVersion:null,expiresAt:null,refresh:"not_applicable"},
    {...ready,status:"not_selected",selectedCredentialRevision:null,credentialRevision:null,materialVersion:null,expiresAt:null,refresh:"not_applicable"},
  ])("keeps CP and renderer metadata parsers equivalent",value=>{
    expect(Backend.parse(value)).toEqual(CloudAgentConnectionHealthSchema.parse(value));
  });
  it.each([
    {...ready,status:"raw_provider_error"},
    {...ready,refresh:"automatic_refresh_guaranteed"},
    {...ready,admissionToken:"not-authority"},
    {...ready,refreshToken:"not-accepted"},
    {...ready,selectedCredentialRevision:3},
    {...ready,credentialRevision:null},
    {...ready,materialVersion:null},
    {...ready,materialVersion:0},
    {...ready,credentialRevision:Number.MAX_SAFE_INTEGER+1},
    {...ready,status:"credential_changed"},
    {...ready,status:"credential_unavailable"},
    {...ready,status:"not_selected"},
    {...ready,status:"expired",expiresAt:null},
    {...ready,status:"expired"},
    {...ready,status:"expiring",expiresAt:"2026-10-15T11:01:01.000Z"},
    {...ready,status:"expiring",expiresAt:"2026-10-15T10:59:59.000Z"},
    {...ready,expiresAt:"2026-10-15T10:59:59.000Z"},
    {...ready,status:"consent_required",credentialRevision:null,materialVersion:null,expiresAt:null},
  ])("rejects inconsistent, unsafe or credential-bearing observations",value=>{
    for(const parser of parsers)expect(parser.safeParse(value).success).toBe(false);
  });
  it("keeps the additive health field optional for older control planes and ignorable by old clients",()=>{
    const legacy=z.object({provider:z.literal("codex"),revision:z.number(),connected:z.boolean()});
    const current=legacy.extend({health:CloudAgentConnectionHealthSchema.optional()});
    const connection={provider:"codex",revision:3,connected:false};
    expect(current.parse(connection)).toEqual(connection);
    expect(legacy.parse({...connection,health:{...ready,status:"expired",expiresAt:"2026-10-15T10:00:00.000Z"}})).toEqual(connection);
  });
});
