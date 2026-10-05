import fs from 'fs-extra';
import { open } from 'node:fs/promises';

const MAX_INFO_BYTES = 65536;

// Check the leaf before opening: even a read-only open can block on a FIFO.
// Recheck the opened handle and bound reads in case file size changes.
async function readBoardMetadata(infoPath) {
  const check = (stats) => {
    if (stats.isSymbolicLink()) throw new Error('INFO_UF2.TXT must not be a symlink.');
    if (!stats.isFile() || stats.size > MAX_INFO_BYTES) {
      throw new Error('INFO_UF2.TXT must be a regular file no larger than 64 KiB.');
    }
  };
  check(await fs.lstat(infoPath));
  const handle = await open(infoPath, 'r');
  try {
    check(await handle.stat());
    const buffer = Buffer.alloc(MAX_INFO_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_INFO_BYTES) throw new Error('INFO_UF2.TXT is too large (64 KiB maximum).');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

export { readBoardMetadata, MAX_INFO_BYTES };
