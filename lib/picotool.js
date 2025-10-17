import fs from 'fs-extra';
import { execa } from 'execa';

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
    drive,
    picotoolPath,
    timeout = 10000
  } = options;

  const command = await resolveExecutable(picotoolPath);
  const args = ['reboot', '-f'];

  if (serialNumber) {
    args.push('--serial', serialNumber);
  }
  if (bus !== undefined) {
    args.push('--bus', String(bus));
  }
  if (address !== undefined) {
    args.push('--address', String(address));
  }
  if (drive) {
    args.push('--drive', drive);
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

async function getPicotoolVersion(picotoolPath) {
  const command = await resolveExecutable(picotoolPath);
  try {
    const { stdout } = await execa(command, ['version']);
    return stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('picotool is not installed or not available on the PATH.');
    }
    throw error;
  }
}

export { putDeviceInFsMode, getPicotoolVersion };
