import path from 'path';
import fs from 'fs-extra';
import { open } from 'node:fs/promises';
import { readBoardMetadata } from './metadata.js';
import { canonicalizeLocalPath, ensureMountPoint, resolveWithinMount, assertNoSymlinks, safeCopy, rejectBootselStorage } from './fileTransfer.js';

function assertUf2Filename(name, context) {
  if (!name || typeof name !== 'string' || !name.toLowerCase().endsWith('.uf2')) {
    throw new Error(`${context} must reference a .uf2 file.`);
  }
}

const UF2_BLOCK_SIZE = 512;
const RP2040_FAMILY_ID = 0xe48bff56;
const FLASH_START = 0x10000000;
const FLASH_END = 0x11000000;
const MAX_UF2_BLOCKS = (FLASH_END - FLASH_START) / 256;
const MAX_UF2_BYTES = MAX_UF2_BLOCKS * UF2_BLOCK_SIZE;

async function validateUf2Handle(handle) {
  const stats = await handle.stat();
  if (!stats.isFile() || !stats.size || stats.size % UF2_BLOCK_SIZE || stats.size > MAX_UF2_BYTES) {
    throw new Error('Invalid UF2: expected complete 512-byte blocks, at most 32 MiB.');
  }
  const blockCount = stats.size / UF2_BLOCK_SIZE;
  // Fixed-size bitmaps bound memory independently of declared block counts.
  const numbers = Buffer.alloc(MAX_UF2_BLOCKS / 8);
  const addresses = Buffer.alloc(MAX_UF2_BLOCKS / 8);
  const block = Buffer.alloc(UF2_BLOCK_SIZE);
  const mark = (bitmap, index) => {
    const mask = 1 << (index % 8);
    if (bitmap[index >> 3] & mask) return false;
    bitmap[index >> 3] |= mask;
    return true;
  };
  for (let offset = 0; offset < stats.size; offset += UF2_BLOCK_SIZE) {
    let read = 0;
    while (read < UF2_BLOCK_SIZE) {
      const { bytesRead } = await handle.read(block, read, UF2_BLOCK_SIZE - read, offset + read);
      if (!bytesRead) throw new Error('Invalid UF2: truncated block.');
      read += bytesRead;
    }
    const word = (position) => block.readUInt32LE(position);
    if (word(0) !== 0x0a324655 || word(4) !== 0x9e5d5157 || word(508) !== 0x0ab16f30) {
      throw new Error('Invalid UF2: block magic mismatch.');
    }
    if (word(8) !== 0x2000 || word(28) !== RP2040_FAMILY_ID) {
      throw new Error('Invalid UF2: requires RP2040 family ID and only the family-present flag.');
    }
    const address = word(12);
    if (word(16) !== 256 || address % 256 || address < FLASH_START || address + 256 > FLASH_END) {
      throw new Error('Invalid UF2: requires aligned 256-byte payloads in RP2040 flash address space.');
    }
    if (word(24) !== blockCount || word(20) >= blockCount || !mark(numbers, word(20))) {
      throw new Error('Invalid UF2: inconsistent, duplicate or incomplete block numbering.');
    }
    if (!mark(addresses, (address - FLASH_START) / 256)) {
      throw new Error('Invalid UF2: overlapping flash addresses.');
    }
  }
  return { blockCount, size: stats.size, familyId: RP2040_FAMILY_ID };
}

async function validateUf2(firmwarePath) {
  const canonicalFirmware = await canonicalizeLocalPath(firmwarePath);
  if (!(await fs.lstat(canonicalFirmware)).isFile()) {
    throw new Error('Invalid UF2: expected a regular file.');
  }
  const handle = await open(canonicalFirmware, 'r');
  try {
    return await validateUf2Handle(handle);
  } finally {
    await handle.close();
  }
}

async function uploadFirmware(firmwarePath, mountPoint, options = {}) {
  const resolvedFirmware = await canonicalizeLocalPath(firmwarePath);
  const stats = await fs.stat(resolvedFirmware).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new Error(`Firmware file not found: ${firmwarePath}`);
  }
  assertUf2Filename(resolvedFirmware, 'Firmware path');
  await validateUf2(resolvedFirmware);

  const resolvedMount = await ensureMountPoint(mountPoint);
  const targetFilename = options.targetFilename || path.basename(resolvedFirmware);
  const info = await readInfoFile(resolvedMount);
  if (!info || !/^Board-ID:[ \t]*RPI-RP2[ \t]*\r?$/m.test(info)) {
    throw new Error('RP2040 upload requires INFO_UF2.TXT with Board-ID: RPI-RP2 at the BOOTSEL root.');
  }
  assertUf2Filename(targetFilename, 'Target filename');
  if (/[\\/:\x00]/.test(targetFilename) || path.isAbsolute(targetFilename)) {
    throw new Error('Firmware destination must be a root-level filename, not a path.');
  }
  const destination = resolveWithinMount(resolvedMount, targetFilename);
  await safeCopy(resolvedFirmware, destination);
  return destination;
}

async function autoDetectFirmwareFile(mountPoint) {
  const entries = await fs.readdir(mountPoint, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (entry.name.toLowerCase().endsWith('.uf2')) {
      await assertNoSymlinks(path.join(mountPoint, entry.name));
      if (entry.isFile()) candidates.push(entry.name);
    }
  }
  if (candidates.length > 1) throw new Error('Multiple UF2 files found; specify --name explicitly.');
  return candidates[0] || null;
}

async function downloadFirmware(mountPoint, destinationPath, options = {}) {
  const resolvedMount = await ensureMountPoint(mountPoint);
  await rejectBootselStorage(resolvedMount, 'Use firmware backup (backupFirmware via picotool) to read actual flash.');
  let sourceFilename = options.filename;
  if (!sourceFilename) {
    sourceFilename = await autoDetectFirmwareFile(resolvedMount);
    if (!sourceFilename) {
      throw new Error('No UF2 firmware file found on the device. Specify --name to pick one explicitly.');
    }
  }
  assertUf2Filename(sourceFilename, 'Source filename');
  const source = resolveWithinMount(resolvedMount, sourceFilename);
  await assertNoSymlinks(source);
  await rejectBootselStorage(source, 'Use firmware backup (backupFirmware via picotool) to read actual flash.');
  const stats = await fs.stat(source).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new Error(`Firmware file not found on device: ${sourceFilename}`);
  }

  const resolvedDestination = await canonicalizeLocalPath(destinationPath);
  await assertNoSymlinks(resolvedDestination);
  await rejectBootselStorage(resolvedDestination);
  await safeCopy(source, resolvedDestination);
  return { source: sourceFilename, destination: resolvedDestination };
}

async function readInfoFile(mountPoint) {
  const resolvedMount = await ensureMountPoint(mountPoint);
  const infoPath = resolveWithinMount(resolvedMount, 'INFO_UF2.TXT');
  await assertNoSymlinks(infoPath);
  try {
    return (await readBoardMetadata(infoPath)).trim();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

export { uploadFirmware, downloadFirmware, readInfoFile, validateUf2, MAX_UF2_BYTES, MAX_UF2_BLOCKS, RP2040_FAMILY_ID };
