import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as sqlite from '../db/sqlite';
import { openCompleteCheckpointJournal } from '../cloud-complete-checkpoint-journal';
import type { CompleteCheckpointJournalState } from '../cloud-complete-checkpoint-contract';

const roots: string[] = [];
const handles: { close(): void }[] = [];
const source = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
  engineInstanceId: randomUUID(), writerEpoch: randomUUID(), scopeRevision: 1,
  scopeSha256: 'a'.repeat(64), changeSequence: 1, reconcileSequence: 0 };
function directory() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-journal-reader-'));
  fs.chmodSync(value, 0o700); roots.push(value); return value;
}
function open(directory: string, mode: 'create' | 'open') {
  const journal = openCompleteCheckpointJournal({ directory, source, mode });
  handles.push(journal); return journal;
}
function pending(): CompleteCheckpointJournalState {
  return { version: 1, source, pending: { id: randomUUID(), source, startedAtMs: 100, deadlineAtMs: 10_100 },
    lastComplete: null, lastStartedAtMs: 100, retryAtMs: null };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of handles.splice(0)) journal.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('W2 original journal reader custody', () => {
  it('keeps exact pending state through an ordinary reopen', async () => {
    const root = directory(), state = pending(), first = open(root, 'create');
    expect(await first.write(0, state)).toBe(true); first.close();
    expect(await open(root, 'open').read(new AbortController().signal)).toEqual({ revision: 1, state });
  });
  it('refuses a lasting replacement after the original descriptor was selected', async () => {
    const root = directory(), state = pending(), first = open(root, 'create');
    await first.write(0, state);
    const file = path.join(root, 'journal.sqlite');
    fs.renameSync(file, file + '.retained');
    const empty = open(root, 'create'); empty.close();
    await expect(first.read(new AbortController().signal)).rejects.toThrow('unconfirmed');
  });
  it('never reports a replacement empty database as the retained pending original', async () => {
    const root = directory(), alternative = directory(), state = pending();
    const first = open(root, 'create'), second = open(alternative, 'create');
    await first.write(0, state); first.close(); second.close();
    const file = path.join(root, 'journal.sqlite'), other = path.join(alternative, 'journal.sqlite');
    const retained = file + '.retained', originalInode = fs.statSync(file).ino;
    const nativeOpen = sqlite.openSqlite;
    let swaps = 0;
    vi.spyOn(sqlite, 'openSqlite').mockImplementation((selected, options) => {
      swaps++;
      fs.renameSync(file, retained); fs.renameSync(other, file);
      try { return nativeOpen(selected, options); }
      finally { fs.renameSync(file, other); fs.renameSync(retained, file); }
    });
    let actual: unknown;
    try { actual = await open(root, 'open').read(new AbortController().signal); }
    catch { actual = 'refused'; }
    vi.restoreAllMocks();
    expect(swaps).toBe(1);
    expect(fs.statSync(file).ino).toBe(originalInode);
    expect(await open(root, 'open').read(new AbortController().signal)).toEqual({ revision: 1, state });
    // Either preserve the held original or refuse. An accepted empty read can
    // make pauseForFinalSave overlook the original outstanding producer.
    expect(actual === 'refused' || JSON.stringify(actual) === JSON.stringify({ revision: 1, state })).toBe(true);
  });
});
