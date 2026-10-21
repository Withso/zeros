import { describe, expect, it } from 'vitest';
import { CloudRuntimeConnectionTargetSchema, RuntimeConnectionTargetSchema } from '../cloud-runtime-connection';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const target = {
  kind: 'cloud', runtimeId: uuid(10), organizationId: uuid(1), workspaceId: uuid(2), generation: 3, authorityEpoch: 9,
  engineInstanceId: uuid(4), connectionSequence: 1, expiresAt: 1791483600000, channel: 'v2-websocket',
  url: `wss://api.zeros.build/v2/cloud/workspaces/${uuid(2)}/bridge`, protocols: ['zeros.cloud.v2', `ticket.zw2c_${'A'.repeat(43)}`],
};

describe('cloud v2 connection target', () => {
  it('accepts the relay URL for its own workspace and the ticket subprotocol', () => {
    expect(CloudRuntimeConnectionTargetSchema.safeParse(target).success).toBe(true);
    expect(RuntimeConnectionTargetSchema.safeParse({ kind: 'local' }).success).toBe(true);
    expect(CloudRuntimeConnectionTargetSchema.safeParse({ ...target, url: 'ws://127.0.0.1:3000/v2/cloud/workspaces/' + uuid(2) + '/bridge' }).success).toBe(true);
  });

  it.each([
    { url: `wss://api.zeros.build/v2/cloud/workspaces/${uuid(3)}/bridge` },
    { url: `ws://api.zeros.build/v2/cloud/workspaces/${uuid(2)}/bridge` },
    { url: `wss://api.zeros.build/v2/cloud/workspaces/${uuid(2)}/bridge?ticket=x` },
    { protocols: ['zeros.cloud.v2', 'ticket.zw2w_nope'] },
    { channel: 'control-plane-websocket' },
    { cloudToken: `zwa_${'A'.repeat(43)}` },
  ])('refuses %o', change => {
    expect(CloudRuntimeConnectionTargetSchema.safeParse({ ...target, ...change }).success).toBe(false);
  });
});
