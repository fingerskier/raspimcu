import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { findMountedBoards } from '../lib/devices.js';

// Reproducible synthetic Linux-shaped fixture; never enumerates serial hardware.
// First-pass is NOT a cold OS-cache measurement: fixture creation warms metadata.
const root = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'discovery-benchmark-'));
const expected = [];
try {
  for (let user = 0; user < 20; user++) {
    for (let volume = 0; volume < 20; volume++) {
      const mount = path.join(root, `user-${user}`, `volume-${volume}`);
      await fs.mkdir(mount, { recursive: true });
      if (volume % 10 === 0) {
        await fs.writeFile(path.join(mount, 'INFO_UF2.TXT'), 'Board-ID: RPI-RP2\nModel: Raspberry Pi Pico\n');
        expected.push(mount);
      }
    }
  }
  const samples = [];
  for (const phase of ['first-pass', 'warm-1', 'warm-2']) {
    const errors = [];
    const start = performance.now();
    const boards = await findMountedBoards([root], { errors });
    const milliseconds = performance.now() - start;
    assert.deepEqual(boards.map((board) => board.mountPoint), expected.sort());
    assert.deepEqual(errors, []);
    samples.push({ phase, milliseconds: Number(milliseconds.toFixed(3)), boards: boards.length });
  }
  console.log(JSON.stringify({ fixture: { users: 20, volumesPerUser: 20, expectedBoards: expected.length },
    concurrency: 4, maxDepth: 2, samples,
    caveat: 'Synthetic local directories only; first-pass is not cold OS cache, and no real-board latency is measured.' }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
