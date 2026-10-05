import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/raspimcu.js', import.meta.url));

describe('packaged CLI smoke tests', () => {
  it('keeps the declared runtime and lockfile metadata in sync', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
    expect(pkg.engines.node).toBe('>=22.12.0');
    expect(lock.packages[''].engines).toEqual(pkg.engines);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });

  it.each([
    [[], 'Manage Raspberry Pi'],
    [['firmware', 'backup'], '--overwrite'],
    [['put-fs'], '--wait-mount'],
    [['micropython', 'repl'], '--exec']
  ])('starts without accessing hardware for %j --help', async (args, expected) => {
    const { stdout } = await execFileAsync(process.execPath, [cli, ...args, '--help'], { timeout: 10000 });
    expect(stdout).toContain(expected);
  });

  it('rejects malformed timeouts before any attempt to connect', async () => {
    await expect(execFileAsync(process.execPath, [
      cli, 'micropython', 'repl', 'not-a-port', '--exec', 'pass', '--timeout', '10junk'
    ], { timeout: 10000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/timeout/i) });
  });
});
