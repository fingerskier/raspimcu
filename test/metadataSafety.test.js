import { afterEach, expect, it } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const fixtures = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((dir) => fs.remove(dir))); });

// Isolate a blocking FIFO open so a regression cannot strand a test worker.
it.skipIf(process.platform === 'win32').each(['info', 'uf2', 'discovery', 'readiness'])(
  'rejects FIFO input without blocking %s', async (operation) => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'metadata-fifo-'));
    fixtures.push(root);
    const file = path.join(root, operation === 'uf2' ? 'input.uf2' : 'INFO_UF2.TXT');
    await exec('mkfifo', [file]);
    const script = `
      import assert from 'node:assert/strict';
      import { readInfoFile, validateUf2 } from './lib/firmware.js';
      import { findMountedBoards, waitForMountedBoard } from './lib/devices.js';
      const root = ${JSON.stringify(root)};
      const operation = ${JSON.stringify(operation)};
      if (operation === 'info') await assert.rejects(readInfoFile(root), /regular file/);
      if (operation === 'uf2') await assert.rejects(validateUf2(${JSON.stringify(file)}), /regular file/);
      if (operation === 'discovery') {
        const errors = [];
        assert.deepEqual(await findMountedBoards([root], { errors }), []);
        assert.match(errors[0].error.message, /regular file/);
      }
      if (operation === 'readiness') {
        await assert.rejects(waitForMountedBoard(root, { timeout: 200, interval: 500 }),
          (error) => error.code === 'ETIMEDOUT' && /regular file/.test(error.errors[0]?.error.message));
      }
      console.log('rejected');
    `;
    const result = await exec(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), timeout: 1500, killSignal: 'SIGKILL'
    });
    expect(result.stdout.trim()).toBe('rejected');
  }
);
