import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupFirmware, getPicotoolVersion } from '../lib/picotool.js';
import { runMicropythonRepl } from '../lib/micropython.js';

// Execute harmless local fake tools through real execa; never contact a board.
// Windows uses a different executable-script mechanism; argument tests run there.
describe.skipIf(process.platform === 'win32')('real subprocess lifecycle with fake tools', () => {
  let root;
  async function tool(name, body) {
    const executable = path.join(root, name);
    await fs.writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
    return executable;
  }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'raspimcu-process-'));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('terminates an unresponsive version command at its deadline', async () => {
    const fake = await tool('version-tool', 'setInterval(() => {}, 1000);');
    await expect(getPicotoolVersion(fake, { timeout: 150 })).rejects.toMatchObject({ timedOut: true });
  });

  it('keeps an empty exec noninteractive through a real child process', async () => {
    const fake = await tool('exec-tool', 'console.log(JSON.stringify(process.argv.slice(2)));');
    const output = await runMicropythonRepl('fake-port', { mpremotePath: fake, code: '' });
    expect(JSON.parse(output)).toEqual(['connect', 'fake-port', 'exec', '']);
  });

  it('publishes a successful fake extraction and removes staging', async () => {
    const fake = await tool('save-tool', "require('node:fs').writeFileSync(process.argv[4], 'fake flash extraction'); console.log('saved');");
    const destination = path.join(root, 'backup.uf2');
    await expect(backupFirmware(destination, { picotoolPath: fake })).resolves.toEqual({ destination, output: 'saved' });
    expect(await fs.readFile(destination, 'utf8')).toBe('fake flash extraction');
    expect((await fs.readdir(root)).filter(name => name.startsWith('.picotool-backup-'))).toEqual([]);
  });

  it('keeps the old backup and removes partial staging after timeout', async () => {
    const fake = await tool('hung-save', "require('node:fs').writeFileSync(process.argv[4], 'partial'); setInterval(() => {}, 1000);");
    const destination = path.join(root, 'backup.uf2');
    await fs.writeFile(destination, 'previous backup');
    await expect(backupFirmware(destination, { picotoolPath: fake, overwrite: true, timeout: 150 })).rejects.toMatchObject({ timedOut: true });
    expect(await fs.readFile(destination, 'utf8')).toBe('previous backup');
    expect((await fs.readdir(root)).filter(name => name.startsWith('.picotool-backup-'))).toEqual([]);
  });
});
