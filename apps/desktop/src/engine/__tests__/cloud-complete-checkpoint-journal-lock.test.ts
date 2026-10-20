import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite } from '../db/sqlite';
import { openCompleteCheckpointJournal } from '../cloud-complete-checkpoint-journal';
import type { CompleteCheckpointJournal, } from '../cloud-complete-checkpoint-journal';
import type { CompleteCheckpointJournalState } from '../cloud-complete-checkpoint-contract';

const roots: string[] = [];
const source = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
  engineInstanceId: randomUUID(), writerEpoch: randomUUID(), scopeRevision: 1,
  scopeSha256: 'a'.repeat(64), changeSequence: 1, reconcileSequence: 0 };
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-journal-lock-'));
  fs.chmodSync(root, 0o700); roots.push(root); return root;
}
const probe = String.raw`
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1], timeout=0.025)
try:
    connection.execute('BEGIN IMMEDIATE')
    print('acquired')
    connection.rollback()
except sqlite3.OperationalError as error:
    if str(error) != 'database is locked':
        raise
    print('busy')
finally:
    connection.close()
`;
function competitor(file: string): string {
  const result = spawnSync('python3', ['-c', probe, file], { encoding: 'utf8', timeout: 3000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout.trim();
}
function ownReservations(file: string): number {
  const original = fs.statSync(file);
  let count = 0;
  for (const name of fs.readdirSync('/proc/self/fd')) {
    const fd = Number(name);
    let stat: fs.Stats;
    try { stat = fs.fstatSync(fd); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EBADF') continue; throw error; }
    if (stat.dev !== original.dev || stat.ino !== original.ino) continue;
    count += fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').split('\n')
      .filter(line => line.startsWith('lock:') && line.includes('POSIX')
        && line.includes('WRITE') && /1073741825 1073741825$/.test(line)).length;
  }
  return count;
}
async function prepare(root: string) {
  const journal = openCompleteCheckpointJournal({ directory: root, source, mode: 'create' });
  const state: CompleteCheckpointJournalState = { version: 1, source,
    pending: { id: randomUUID(), source, startedAtMs: 100, deadlineAtMs: 10_100 },
    lastComplete: null, lastStartedAtMs: 100, retryAtMs: null };
  try { expect(await journal.write(0, state)).toBe(true); }
  finally { journal.close(); }
  return state;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('W2 journal native lock custody', () => {
  it.each(['same', 'different'] as const)('preserves a real %s-inode writer reservation across a journal open or refusal', async relation => {
    const root = directory(), state = await prepare(root);
    const other = relation === 'same' ? root : directory();
    if (other !== root) await prepare(other);
    const file = path.join(root, 'journal.sqlite'), heldFile = path.join(other, 'journal.sqlite');
    const writer = openSqlite(heldFile);
    let opened: CompleteCheckpointJournal | undefined;
    let refused = false;
    try {
      writer.exec('BEGIN IMMEDIATE');
      expect(writer.inTransaction).toBe(true);
      expect(ownReservations(heldFile)).toBe(1);
      expect(competitor(heldFile)).toBe('busy');
      try { opened = openCompleteCheckpointJournal({ directory: root, source, mode: 'open' }); }
      catch { refused = true; }
      const after = { refused, inTransaction: writer.inTransaction,
        ownReservations: ownReservations(heldFile), competitor: competitor(heldFile) };
      console.info('W2 same-inode lock observation', relation, JSON.stringify(after));
      expect(after).toMatchObject({ inTransaction: true, ownReservations: 1, competitor: 'busy' });
    } finally {
      if (writer.inTransaction) writer.exec('ROLLBACK');
      writer.close();
      opened?.close();
    }
    expect(competitor(heldFile)).toBe('acquired');
    const recheck = openCompleteCheckpointJournal({ directory: root, source, mode: 'open' });
    try { expect(await recheck.read(new AbortController().signal)).toEqual({ revision: 1, state }); }
    finally { recheck.close(); }
  });
  it('opens an uncontended original and leaves no native reservation behind', async () => {
    const root = directory(), state = await prepare(root), file = path.join(root, 'journal.sqlite');
    const opened = openCompleteCheckpointJournal({ directory: root, source, mode: 'open' });
    try {
      expect(await opened.read(new AbortController().signal)).toEqual({ revision: 1, state });
      expect(ownReservations(file)).toBe(0);
      expect(competitor(file)).toBe('acquired');
    } finally { opened.close(); }
  });
});
