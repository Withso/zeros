import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('malformed TOML cannot hang settings parsing', () => {
  it.each(['a=[1 #', 'a={b=1 #'])('rejects an unterminated trailing comment: %s', (source) => {
    // A vulnerable parser loops synchronously, so isolate it in a child with
    // a deadline instead of hanging the test runner (GHSA-7w5x-hrqm-74c2).
    const script = `
      import { parse, TomlError } from 'smol-toml';
      try {
        parse(process.argv[1]);
      } catch (error) {
        if (error instanceof TomlError) process.exit(0);
        throw error;
      }
      throw new Error('Malformed TOML was accepted');
    `;
    expect(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script, source], {
      timeout: 2000,
      stdio: 'pipe',
    })).not.toThrow();
  });
});
