import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';
import { normalizeTimeout } from './timeout.js';
import { rejectBootselStorage } from './fileTransfer.js';

async function resolveExecutable(commandPath) {
  if (!commandPath) {
    return 'picotool';
  }
  const exists = await fs.pathExists(commandPath);
  if (!exists) {
    throw new Error(`Specified picotool executable was not found: ${commandPath}`);
  }
  return commandPath;
}

async function putDeviceInFsMode(options = {}) {
  const {
    serialNumber,
    bus,
    address,
    picotoolPath
  } = options;
  const timeout = normalizeTimeout(options.timeout, 10000);

  if (options.drive !== undefined) {
    throw new TypeError('picotool drive targeting is not supported; use serialNumber, bus or address.');
  }
  const command = await resolveExecutable(picotoolPath);
  const args = ['reboot', '-u', '-f'];

  if (serialNumber) {
    args.push('--ser', serialNumber);
  }
  if (bus !== undefined) {
    args.push('--bus', String(bus));
  }
  if (address !== undefined) {
    args.push('--address', String(address));
  }


  try {
    const { stdout } = await execa(command, args, { timeout });
    return stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('picotool is not installed or not available on the PATH.');
    }
    throw error;
  }
}

async function getPicotoolVersion(picotoolPath, options = {}) {
  const timeout = normalizeTimeout(options.timeout, 10000);
  const command = await resolveExecutable(picotoolPath);
  try {
    const { stdout } = await execa(command, ['version'], { timeout });
    return stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('picotool is not installed or not available on the PATH.');
    }
    throw error;
  }
}

async function backupFirmware(destinationPath, options = {}) {
  const timeout = normalizeTimeout(options.timeout, 60000);
  if (options.drive !== undefined) {
    throw new TypeError('picotool drive targeting is not supported; use serialNumber, bus or address.');
  }
  const destination = path.resolve(destinationPath);
  const parent = await fs.realpath(path.dirname(destination));
  const publicationDestination = path.join(parent, path.basename(destination));
  await rejectBootselStorage(publicationDestination, 'Choose a local persistent directory for flash backups.');
  const existing = await fs.lstat(publicationDestination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Backup destination must not be a symlink: ${destination}`);
  }
  if (existing && options.overwrite !== true) {
    throw Object.assign(new Error(`Backup destination already exists: ${destination}; use overwrite: true to replace it.`), { code: 'EEXIST' });
  }
  const command = await resolveExecutable(options.picotoolPath);
  const stagingDir = await fs.mkdtemp(path.join(parent, '.picotool-backup-'));
  const staged = path.join(stagingDir, 'backup.uf2');
  try {
    if (options.overwrite !== true) {
      const probe = path.join(stagingDir, 'hardlink-probe');
      const linkedProbe = path.join(stagingDir, 'hardlink-probe-link');
      await fs.writeFile(probe, '', { flag: 'wx' });
      try {
        await fs.link(probe, linkedProbe);
      } catch (error) {
        throw new Error('Backup no-overwrite publication requires hard links. Choose a local filesystem that supports hard links, or explicitly use overwrite: true if replacement is intended.', { cause: error });
      }
      await fs.remove(linkedProbe);
      await fs.remove(probe);
    }
    const args = ['save', '-a', staged, '-t', 'uf2'];
    if (options.serialNumber) args.push('--ser', options.serialNumber);
    if (options.bus !== undefined) args.push('--bus', String(options.bus));
    if (options.address !== undefined) args.push('--address', String(options.address));
    if (options.force === true) args.push('-f');
    const { stdout } = await execa(command, args, { timeout }).catch(error => {
      if (error.code === 'ENOENT') {
        throw new Error('picotool is not installed or not available on the PATH.', { cause: error });
      }
      throw error;
    });
    // Flash may contain credentials; never publish picotool's permissive mode.
    await fs.chmod(staged, 0o600);
    // Same-filesystem publication is atomic. link also refuses a racing creator.
    if (options.overwrite === true) await fs.rename(staged, publicationDestination);
    else await fs.link(staged, publicationDestination);
    return { destination, output: stdout.trim() };
  } finally {
    await fs.remove(stagingDir);
  }
}

export { putDeviceInFsMode, getPicotoolVersion, backupFirmware };
