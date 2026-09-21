import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('pinned SSH Ed25519 key encoding', () => {
  it('preserves a leading zero in the fixed-width public key', () => {
    // A deterministic, test-only seed whose public point begins with zero.
    const result = execFileSync(process.execPath, ['-e', `
      const crypto = require('node:crypto');
      const seed = Buffer.alloc(32); seed.writeUInt32BE(36, 28);
      const key = crypto.createPrivateKey({ key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'), seed
      ]), format: 'der', type: 'pkcs8' });
      const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
      const privateKey = key.export({ type: 'pkcs8', format: 'der' });
      crypto.generateKeyPairSync = () => ({ publicKey, privateKey });
      const { utils } = require('ssh2');
      const generated = utils.generateKeyPairSync('ed25519');
      const parsed = utils.parseKey(generated.public);
      const raw = Buffer.from(generated.public.split(' ')[1], 'base64');
      console.log(JSON.stringify({ length: raw.length, pointLength: raw.readUInt32BE(15),
        firstByte: raw[19], parsed: typeof parsed.getPublicSSH === 'function' }));
    `], { encoding: 'utf8' });
    expect(JSON.parse(result)).toEqual({ length: 51, pointLength: 32, firstByte: 0, parsed: true });
  });
});
