#!/usr/bin/env node
import process from 'process';
import { uploadFirmware } from '../lib/firmware.js';

async function main() {
  const [firmwarePath, mountPoint, targetFilename] = process.argv.slice(2);

  if (!firmwarePath || !mountPoint) {
    console.error('Usage: node manual-tests/upload-firmware.js <firmware.uf2> <mount-point> [target-filename.uf2]');
    process.exitCode = 1;
    return;
  }

  try {
    const destination = await uploadFirmware(firmwarePath, mountPoint, {
      targetFilename: targetFilename && targetFilename.trim().length > 0 ? targetFilename : undefined,
    });

    console.log(`Firmware copied to ${destination}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}

