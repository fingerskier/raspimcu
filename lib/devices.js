import path from 'path';
import fs from 'fs-extra';

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
  try {
    const stats = await fs.stat(volumePath);
    if (!stats.isDirectory()) {
      return false;
    }
  } catch (error) {
    return false;
  }

  const infoFile = path.join(volumePath, 'INFO_UF2.TXT');
  const indexFile = path.join(volumePath, 'INDEX.HTM');
  if (!(await fs.pathExists(infoFile)) && !(await fs.pathExists(indexFile))) {
    return false;
  }

  let infoContents = '';
  if (await fs.pathExists(infoFile)) {
    try {
      infoContents = await fs.readFile(infoFile, 'utf8');
    } catch (error) {
      infoContents = '';
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

async function findMountedBoards(searchRoots = getDefaultSearchRoots()) {
  const results = [];
  for (const root of searchRoots) {
    try {
      const exists = await fs.pathExists(root);
      if (!exists) {
        continue;
      }
      const stats = await fs.stat(root);
      if (!stats.isDirectory()) {
        continue;
      }

      const asBoard = await isBoardStorage(root);
      if (asBoard) {
        results.push(asBoard);
      }

      const entries = await fs.readdir(root);
      for (const entry of entries) {
        const volumePath = path.join(root, entry);
        const board = await isBoardStorage(volumePath);
        if (board) {
          results.push(board);
        }
      }
    } catch (error) {
      // Ignore inaccessible roots.
    }
  }
  return dedupeById(results);
}

function dedupeById(devices) {
  const seen = new Map();
  for (const device of devices) {
    if (!seen.has(device.id)) {
      seen.set(device.id, device);
    }
  }
  return Array.from(seen.values());
}

function extractInfoValue(infoContents, key) {
  if (!infoContents) {
    return undefined;
  }
  const regex = new RegExp(`${key}:[^\n]*`, 'i');
  const match = infoContents.match(regex);
  if (!match) {
    return undefined;
  }
  const [, value] = match[0].split(/:\s*/);
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
  const { searchRoots } = options;
  const result = {
    devices: [],
    errors: []
  };

  try {
    const serialDevices = await listSerialPorts();
    result.devices.push(...serialDevices);
  } catch (error) {
    result.errors.push({
      source: 'serial',
      error
    });
  }

  try {
    const mountedBoards = await findMountedBoards(searchRoots || getDefaultSearchRoots());
    result.devices.push(...mountedBoards);
  } catch (error) {
    result.errors.push({
      source: 'storage',
      error
    });
  }

  result.devices = filterRp2040Devices(result.devices);

  return result;
}

export {
  listDevices,
  listSerialPorts,
  findMountedBoards,
  getDefaultSearchRoots,
  RASPBERRY_PI_VENDOR_IDS,
  BOOTSEL_PRODUCT_IDS,
  isRp2040Device,
  filterRp2040Devices
};
