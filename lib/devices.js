import path from 'path';
import fs from 'fs-extra';
import { normalizeTimeout } from './timeout.js';
import { readBoardMetadata } from './metadata.js';

let serialPortModulePromise;

async function loadSerialPort() {
  if (!serialPortModulePromise) {
    serialPortModulePromise = import('serialport')
      .then((module) => module.SerialPort)
      .catch(() => null);
  }
  return serialPortModulePromise;
}

const RASPBERRY_PI_VENDOR_IDS = new Set(['2E8A']);
const BOOTSEL_PRODUCT_IDS = new Set(['0003', '0004']);

const RP2040_STORAGE_HINTS = [
  /RP2040/i,
  /RPI[-_ ]?RP2/i,
  /\bPICO\b/i
];

const WINDOWS_DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function normalizeHex(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'number') {
    return value.toString(16).toUpperCase().padStart(4, '0');
  }
  return String(value).replace(/^0x/i, '').toUpperCase().padStart(4, '0');
}

function formatError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      code: error.code,
      stack: error.stack,
      name: error.name
    };
  }

  return {
    message: String(error)
  };
}

async function listSerialPorts() {
  const SerialPort = await loadSerialPort();
  if (!SerialPort || typeof SerialPort.list !== 'function') {
    throw new Error('serialport package is not available. Install it to enable serial device detection.');
  }

  let ports;
  try {
    ports = await SerialPort.list();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Unable to enumerate serial ports: ${message}`);
  }
  const devices = [];
  for (const port of ports) {
    const vendorId = normalizeHex(port.vendorId);
    const productId = normalizeHex(port.productId);
    if (vendorId && !RASPBERRY_PI_VENDOR_IDS.has(vendorId)) {
      continue;
    }
    devices.push({
      id: port.path || port.pnpId || `${vendorId || 'unknown'}:${productId || 'unknown'}`,
      type: 'serial',
      status: 'serial',
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      vendorId,
      productId,
      locationId: port.locationId,
      friendlyName: port.friendlyName,
      description: port.friendlyName || port.manufacturer || 'Raspberry Pi MCU (serial mode)'
    });
  }
  return devices;
}

function getDefaultSearchRoots() {
  if (process.platform === 'darwin') {
    return ['/Volumes'];
  }
  if (process.platform === 'win32') {
    return WINDOWS_DRIVE_LETTERS.map((letter) => `${letter}:\\`);
  }
  // Linux and other unix-like systems.
  return ['/media', '/run/media', '/mnt'];
}

async function isBoardStorage(volumePath) {
  const infoFile = path.join(volumePath, 'INFO_UF2.TXT');
  const indexFile = path.join(volumePath, 'INDEX.HTM');

  // Metadata must be a bounded regular file, never a leaf symlink or FIFO.
  let infoContents = '';
  try {
    infoContents = await readBoardMetadata(infoFile);
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      if (!(await fs.lstat(indexFile)).isFile()) return false;
    } catch (indexError) {
      if (!isMissing(indexError)) throw indexError;
      return false;
    }
  }

  const boardId = extractInfoValue(infoContents, 'Board-ID');
  const model = extractInfoValue(infoContents, 'Model');

  return {
    id: `storage:${volumePath}`,
    type: 'storage',
    status: 'fs',
    mountPoint: volumePath,
    boardId,
    model,
    infoFile: infoContents.trim() || undefined,
    description: model || boardId || 'Raspberry Pi MCU (filesystem mode)'
  };
}

/**
 * Scan roots and up to maxDepth (default 2) descendant levels. concurrency
 * (default 4) bounds all filesystem probes, not just the number of roots.
 * Returns an array sorted by absolute mount path. Optional errors receives
 * { source: 'storage', root, path, error } diagnostics; missing paths are normal.
 */
async function findMountedBoards(searchRoots = getDefaultSearchRoots(), options = {}) {
  const concurrency = options.concurrency ?? 4;
  const maxDepth = options.maxDepth ?? 2;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new TypeError('maxDepth must be a non-negative integer');
  const diagnostics = [];
  const cache = new Map();
  const expanded = new Map();
  const results = new Map();
  let candidates = [...new Set(searchRoots.map((root) => path.resolve(root)))].map((root) => ({
    path: root, root, remaining: maxDepth, knownDirectory: false
  }));
  // Each worker performs at most one filesystem operation at a time. Level
  // barriers and the cache prevent overlapping roots from duplicating probes.
  while (candidates.length) {
    const unique = new Map();
    for (const candidate of candidates) {
      const previous = unique.get(candidate.path);
      if (!previous || previous.remaining < candidate.remaining) unique.set(candidate.path, candidate);
    }
    const batch = [...unique.values()];
    const next = new Array(batch.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      while (cursor < batch.length) {
        const index = cursor++;
        const candidate = batch[index];
        next[index] = [];
        try {
          let entry = cache.get(candidate.path);
          if (!entry) {
            entry = { board: false, directory: candidate.knownDirectory };
            cache.set(candidate.path, entry);
            if (!entry.directory) entry.directory = (await fs.lstat(candidate.path)).isDirectory();
            if (!entry.directory) continue;
            try {
              entry.board = await isBoardStorage(candidate.path);
            } catch (error) {
              if (!isMissing(error)) diagnostics.push({ source: 'storage', root: candidate.root,
                path: candidate.path, error: formatError(error) });
            }
          }
          if (!entry.directory) continue;
          if (entry.board) {
            results.set(entry.board.id, entry.board);
            // Generic INFO/INDEX documents are candidates, not board boundaries.
            if (entry.board.boardId || isRp2040StorageDevice(entry.board)) continue;
          }
          if (candidate.remaining <= 0 || (expanded.get(candidate.path) ?? -1) >= candidate.remaining) continue;
          expanded.set(candidate.path, candidate.remaining);
          entry.children ??= await fs.readdir(candidate.path, { withFileTypes: true });
          next[index] = entry.children.filter((child) => child.isDirectory() && !child.isSymbolicLink())
            .sort((a, b) => comparePaths(a.name, b.name))
            .map((child) => ({ path: path.join(candidate.path, child.name), root: candidate.root,
              remaining: candidate.remaining - 1, knownDirectory: true }));
        } catch (error) {
          if (!isMissing(error)) diagnostics.push({ source: 'storage', root: candidate.root,
            path: candidate.path, error: formatError(error) });
        }
      }
    }));
    candidates = next.flat();
  }
  options.errors?.push(...diagnostics.sort((a, b) => comparePaths(a.path, b.path)));
  return [...results.values()].sort((a, b) => comparePaths(a.mountPoint, b.mountPoint));
}

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function extractInfoValue(infoContents, key) {
  if (!infoContents) {
    return undefined;
  }
  const regex = new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)`, 'im');
  const match = infoContents.match(regex);
  if (!match) {
    return undefined;
  }
  const value = match[1];
  return value ? value.trim() : undefined;
}

function normalizeVendorId(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return normalizeHex(value);
}

function isRp2040StorageDevice(device) {
  const haystacks = [device.boardId, device.model, device.infoFile];
  return haystacks.some((value) =>
    typeof value === 'string' && RP2040_STORAGE_HINTS.some((regex) => regex.test(value))
  );
}

function isRp2040Device(device) {
  if (!device || typeof device !== 'object') {
    return false;
  }

  if (device.type === 'serial') {
    const vendorId = normalizeVendorId(device.vendorId);
    return Boolean(vendorId && RASPBERRY_PI_VENDOR_IDS.has(vendorId));
  }

  if (device.type === 'storage') {
    return isRp2040StorageDevice(device);
  }

  return false;
}

function filterRp2040Devices(devices) {
  return devices.filter((device) => isRp2040Device(device));
}

async function listDevices(options = {}) {
  const storageErrors = [];
  const storageRoots = options.searchRoots ?? getDefaultSearchRoots();
  const [serial, storage] = await Promise.allSettled([
    listSerialPorts(),
    (async () => {
      if (Array.isArray(storageRoots) && storageRoots.length === 0) {
        throw new Error('No search roots were provided for mounted board detection.');
      }
      return findMountedBoards(storageRoots, { ...options, errors: storageErrors });
    })()
  ]);
  const devices = [];
  const errors = [];
  for (const [source, branch] of [['serial', serial], ['storage', storage]]) {
    if (branch.status === 'fulfilled') devices.push(...branch.value.sort((a, b) => comparePaths(a.id, b.id)));
    else errors.push({ source, error: formatError(branch.reason) });
  }
  errors.push(...storageErrors);
  return { devices: filterRp2040Devices(devices), errors };
}

/**
 * Wait for RP2040 metadata at exactly mountPoint, without serial enumeration or
 * descendant discovery. timeout/interval are positive integer milliseconds
 * (defaults 10000/100). Rejects with ETIMEDOUT and storage diagnostics by deadline.
 * An already-running OS filesystem request cannot be cancelled, but no further
 * polls are scheduled after settlement.
 */
async function waitForMountedBoard(mountPoint, options = {}) {
  if (typeof mountPoint !== 'string' || !mountPoint.trim()) throw new TypeError('mountPoint must be an explicit non-empty path');
  const timeout = normalizeTimeout(options.timeout, 10000);
  let interval;
  try {
    interval = normalizeTimeout(options.interval, 100);
  } catch (error) {
    throw new TypeError(`Invalid interval: ${error.message}`);
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    let pollTimer;
    let errors = [];
    const deadlineTimer = setTimeout(() => {
      finished = true;
      clearTimeout(pollTimer);
      const details = errors.map((entry) => entry.error.message).join('; ');
      reject(Object.assign(new Error(`Timed out waiting for RP2040 board at ${mountPoint}${details ? `: ${details}` : ''}`),
        { code: 'ETIMEDOUT', errors }));
    }, timeout);
    const poll = async () => {
      errors = [];
      try {
        const devices = await findMountedBoards([mountPoint], { maxDepth: 0, errors });
        if (finished) return;
        const device = devices.find((candidate) => candidate.boardId === 'RPI-RP2');
        if (device) {
          finished = true;
          clearTimeout(deadlineTimer);
          resolve(device);
        } else {
          pollTimer = setTimeout(poll, interval);
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        clearTimeout(deadlineTimer);
        reject(error);
      }
    };
    void poll();
  });
}

async function getSingleDevice(options = {}) {
  const { type } = options;
  const result = await listDevices(options);

  let devices = result.devices;
  if (type) {
    devices = devices.filter((d) => d.type === type);
  }

  if (devices.length === 0) {
    const details = result.errors.map((entry) => `${entry.source}${entry.root ? ` (${entry.root})` : ''}: ${entry.error.message}`);
    return { device: null, count: 0, errors: result.errors,
      error: `No devices found${details.length ? `. ${details.join('; ')}` : ''}` };
  }

  if (devices.length === 1) {
    return { device: devices[0], count: 1, error: null };
  }

  return {
    device: null,
    count: devices.length,
    error: `Multiple devices found (${devices.length}). Please specify which device to use.`
  };
}

export {
  listDevices,
  listSerialPorts,
  findMountedBoards,
  waitForMountedBoard,
  getDefaultSearchRoots,
  getSingleDevice,
  RASPBERRY_PI_VENDOR_IDS,
  BOOTSEL_PRODUCT_IDS,
  isRp2040Device,
  filterRp2040Devices
};
