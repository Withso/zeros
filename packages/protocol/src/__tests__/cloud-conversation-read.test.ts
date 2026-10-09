import { describe, expect, it } from 'vitest';
import { CloudConversationReadSchema } from '../cloud-commands';

const conversationId = '6606c246-6cec-4330-ad2b-2ea9a0b60484';

describe('cloud conversation timing inspection negotiation', () => {
  it('retains the legacy conversation read shape', () => {
    expect(CloudConversationReadSchema.parse({ conversationId })).toEqual({ conversationId });
  });

  it('accepts only the explicit version-one timing opt-in', () => {
    const request = { conversationId, agentTurnTimingsVersion: 1 };
    expect(CloudConversationReadSchema.parse(request)).toEqual(request);
  });

  it.each([0, 2, '1', null, true])('rejects timing version %j', agentTurnTimingsVersion => {
    expect(CloudConversationReadSchema.safeParse({ conversationId, agentTurnTimingsVersion }).success).toBe(false);
  });

  it('retains strict unknown-field rejection', () => {
    expect(CloudConversationReadSchema.safeParse({ conversationId, timingDebug: true }).success).toBe(false);
  });
});
