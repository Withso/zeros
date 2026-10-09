// Real renderer class is exercised; this is not a provider-success test.
import { describe, it, expect, vi } from 'vitest';
import { createRendererDriver } from '../cloud-workspace-validation/cloud-agent-e2e/renderer-driver';
import type { BridgeMessage } from '../cloud-workspace-validation/lib/bridge-client';

const chat = '11111111-1111-4111-8111-111111111111';
const grant = '22222222-2222-4222-8222-222222222222';
const execution = '33333333-3333-4333-8333-333333333333';
function fixture() {
  const listeners = new Set<(frame: BridgeMessage) => void>();
  const statusListeners = new Set<(status: 'connected' | 'disconnected') => void>();
  let mutation: Record<string, unknown> | undefined;
  let status: 'connected' | 'disconnected' = 'connected';
  const requestEnvelope = vi.fn(async (op: string, params: Record<string, unknown> = {}) => {
    let result: unknown = { conversationId: chat, modeRevision: 0, permissionModeVersion: 1,
      nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1 };
    const input = params.request as Record<string, unknown> | undefined;
    if (op === 'cloudCommands.request' && input?.kind === 'snapshot') result = {
      version: 1, conversationId: chat, revision: 0, paused: false, pending: [], receipts: [] };
    if (op === 'cloudCommands.request' && input?.kind === 'mutate') mutation = input.mutation as Record<string, unknown>;
    if (op === 'cloudCommands.request' && input?.kind === 'read') result = {
      conversationId: chat, commandId: input.commandId, position: 1, state: 'failed', payload: null,
      executionId: execution, generation: 1, resultCode: 'cloud_provider_prompt_auth_required',
      createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' };
    return { type: 'WORKSPACE_RESPONSE', source: 'engine', op, result } as BridgeMessage;
  });
  const bridge = { requestEnvelope, get status() { return status; },
    onMessage(listener: (frame: BridgeMessage) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    onStatusChange(listener: (value: 'connected' | 'disconnected') => void) { statusListeners.add(listener); return () => statusListeners.delete(listener); } };
  return { bridge, requestEnvelope, mutation: () => mutation, listeners, statusListeners,
    emit(frame: BridgeMessage) { for (const listener of listeners) listener(frame); },
    disconnect() { status = 'disconnected'; for (const listener of statusListeners) listener(status); } };
}
async function attach(driver: ReturnType<typeof createRendererDriver>) {
  await driver.connection.request({ type: 'AGENT_NEW_SESSION', chatId: chat, agentId: 'codex', env: { OPENAI_MODEL: 'test-model' } });
}
const prompt = () => ({ type: 'AGENT_PROMPT', sessionId: `conversation:${chat}`,
  userMessageId: '44444444-4444-4444-8444-444444444444', prompt: [{ type: 'text', text: 'fixture prompt' }] });

describe('actual headless CloudAgentConnection send', () => {
  it('preserves strict engine operation params and the explicit create workspace identity', async () => {
    const f = fixture(); const driver = createRendererDriver(f.bridge, 'local-main', async () => grant);
    try {
      await attach(driver);
      expect(f.requestEnvelope).toHaveBeenCalledWith('cloudCommands.createConversation',
        { conversationId: chat, workspaceId: 'local-main', agentId: 'codex', model: 'test-model' }, expect.anything());
      for (const [op, params] of [
        ['cloudCommands.conversation', { conversationId: chat }],
        ['cloudCommands.request', { nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1,
          request: { kind: 'snapshot', conversationId: chat } }],
        ['cloudEvents.request', { request: { kind: 'replay', cursor: { streamId: execution, sequence: 0 } } }],
      ] as const) {
        await driver.client.request({ type: 'WORKSPACE_REQUEST', op, params });
        expect(f.requestEnvelope).toHaveBeenLastCalledWith(op, params, expect.anything());
      }
    } finally { driver.dispose(); }
  });
  it('counts the real pre-enqueue grant dependency and reads while grant is blocked', async () => {
    const f = fixture(); let release!: (id: string) => void;
    const authorize = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const driver = createRendererDriver(f.bridge, 'local-main', authorize);
    try {
      await attach(driver);
      const flight = driver.connection.request(prompt());
      await Promise.resolve(); await Promise.resolve();
      expect(authorize).toHaveBeenCalledExactlyOnceWith('codex', 'test-model');
      expect(f.requestEnvelope.mock.calls.some(([op, params]) => op === 'cloudCommands.conversation')).toBe(true);
      expect(f.requestEnvelope.mock.calls.some(([op, params]) => op === 'cloudCommands.request' && (params?.request as { kind?: string })?.kind === 'snapshot')).toBe(true);
      expect(f.mutation()).toBeUndefined();
      release(grant);
      await expect(flight).resolves.toMatchObject({ type: 'AGENT_PROMPT_FAILED', error: 'cloud_provider_prompt_auth_required' });
      const action = f.mutation()?.action as Record<string, unknown>;
      expect(action).toMatchObject({ kind: 'enqueue', payload: { agentCredentialGrantId: grant, model: 'test-model' } });
    } finally { driver.dispose(); }
  });
  it('preserves stable mutation identity for the actual optimistic user-message identity', async () => {
    const f = fixture(); const driver = createRendererDriver(f.bridge, 'local-main', async () => grant);
    try {
      await attach(driver); await driver.connection.request(prompt());
      const first = f.mutation()?.operationId;
      await driver.connection.request(prompt());
      expect(f.mutation()?.operationId).toBe(first);
      expect(first).toMatch(/^[a-f0-9-]{36}$/);
    } finally { driver.dispose(); }
  });
  it('retains exact WORKSPACE_ERROR semantics instead of wrapping a failure as an empty success', async () => {
    const f = fixture(); const driver = createRendererDriver(f.bridge, 'local-main', async () => grant);
    try {
      await attach(driver);
      f.requestEnvelope.mockResolvedValueOnce({ type: 'WORKSPACE_ERROR', source: 'engine', code: 'command_context_changed', message: 'command_context_changed' });
      await expect(driver.connection.request(prompt())).rejects.toThrow('command_context_changed');
      expect(f.mutation()).toBeUndefined();
    } finally { driver.dispose(); }
  });
  it('does not submit when the renderer grant preparation rejects', async () => {
    const f = fixture(); const driver = createRendererDriver(f.bridge, 'local-main', async () => { throw new Error('cloud_agent_credential_required'); });
    try { await attach(driver); await expect(driver.connection.request(prompt())).rejects.toThrow('cloud_agent_credential_required');
      expect(f.mutation()).toBeUndefined(); } finally { driver.dispose(); }
  });
  it('routes replay-bearing native frames through the actual ordered renderer reader', async () => {
    const f = fixture(); const driver = createRendererDriver(f.bridge, 'local-main', async () => grant);
    try {
      await attach(driver);
      const seen = vi.fn(); const off = driver.events.on('AGENT_SESSION_UPDATE', seen);
      f.emit({ type: 'AGENT_SESSION_UPDATE', source: 'engine', agentId: 'codex', chatId: chat, executionId: execution,
        cloudStream: { streamId: '55555555-5555-4555-8555-555555555555', sequence: 1 },
        notification: { sessionId: execution, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture' } } } });
      expect(seen).toHaveBeenCalledOnce();
      off();
    } finally { driver.dispose(); }
  });
  it('rejects an engine workspace override at the adapter boundary', async () => {
    const f = fixture(); const driver = createRendererDriver(f.bridge, 'local-main', async () => grant);
    try {
      await expect(driver.client.request({ type: 'WORKSPACE_REQUEST', op: 'cloudCommands.conversation',
        params: { workspaceId: 'foreign-workspace', conversationId: chat } })).rejects.toThrow('renderer_workspace_mismatch');
      expect(f.requestEnvelope).not.toHaveBeenCalled();
    } finally { driver.dispose(); }
  });
  it('disposes event and status observers without closing a reusable authenticated bridge', async () => {
    const f = fixture(); const driver = createRendererDriver(f.bridge, 'local-main', async () => grant);
    expect(f.listeners.size).toBeGreaterThan(0); expect(f.statusListeners.size).toBeGreaterThan(0);
    driver.dispose(); driver.dispose();
    expect(f.listeners.size).toBe(0); expect(f.statusListeners.size).toBe(0);
  });
});
