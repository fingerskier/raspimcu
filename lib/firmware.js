import path from 'path';
import fs from 'fs-extra';
import { ensureMountPoint, resolveWithinMount } from './fileTransfer.js';

function assertUf2Filename(name, context) {
  if (!name || typeof name !== 'string' || !name.toLowerCase().endsWith('.uf2')) {
    throw new Error(`${context} must reference a .uf2 file.`);
  }
}

async function uploadFirmware(firmwarePath, mountPoint, options = {}) {
  const resolvedFirmware = path.resolve(firmwarePath);
  const stats = await fs.stat(resolvedFirmware).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new Error(`Firmware file not found: ${firmwarePath}`);
  }
  assertUf2Filename(resolvedFirmware, 'Firmware path');

  const resolvedMount = await ensureMountPoint(mountPoint);
  const targetFilename = options.targetFilename || path.basename(resolvedFirmware);
  assertUf2Filename(targetFilename, 'Target filename');
  const destination = resolveWithinMount(resolvedMount, targetFilename);
  await fs.ensureDir(path.dirname(destination));
  await fs.copy(resolvedFirmware, destination, { overwrite: true });
  return destination;
}

async function autoDetectFirmwareFile(mountPoint) {
  const entries = await fs.readdir(mountPoint).catch(() => []);
  for (const entry of entries) {
    if (entry.toLowerCase().endsWith('.uf2')) {
      return entry;
    }
  }
  return null;
}

async function downloadFirmware(mountPoint, destinationPath, options = {}) {
  const resolvedMount = await ensureMountPoint(mountPoint);
  let sourceFilename = options.filename;
  if (!sourceFilename) {
    sourceFilename = await autoDetectFirmwareFile(resolvedMount);
    if (!sourceFilename) {
      throw new Error('No UF2 firmware file found on the device. Specify --filename to pick one explicitly.');
    }
  }
  assertUf2Filename(sourceFilename, 'Source filename');
  const source = resolveWithinMount(resolvedMount, sourceFilename);
  const stats = await fs.stat(source).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new Error(`Firmware file not found on device: ${sourceFilename}`);
  }

  const resolvedDestination = path.resolve(destinationPath);
  await fs.ensureDir(path.dirname(resolvedDestination));
  await fs.copy(source, resolvedDestination, { overwrite: true });
  return { source: sourceFilename, destination: resolvedDestination };
}

async function readInfoFile(mountPoint) {
  const resolvedMount = await ensureMountPoint(mountPoint);
  const infoPath = resolveWithinMount(resolvedMount, 'INFO_UF2.TXT');
  const exists = await fs.pathExists(infoPath);
  if (!exists) {
    return null;
  }
  const contents = await fs.readFile(infoPath, 'utf8');
  return contents.trim();
}

export { uploadFirmware, downloadFirmware, readInfoFile };
