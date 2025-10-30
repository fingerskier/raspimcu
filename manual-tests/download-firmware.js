#!/usr/bin/env node
import process from 'process';
import { downloadFirmware, readInfoFile } from '../lib/firmware.js';

async function main() {
  const [mountPoint, destination, sourceFilename] = process.argv.slice(2);

  if (!mountPoint || !destination) {
    console.error('Usage: node manual-tests/download-firmware.js <mount-point> <destination.uf2> [filename.uf2]');
    process.exitCode = 1;
    return;
  }

  try {
    const result = await downloadFirmware(mountPoint, destination, {
      filename: sourceFilename && sourceFilename.trim().length > 0 ? sourceFilename : undefined,
    });

    console.log(`Firmware ${result.source} copied to ${result.destination}`);

    const info = await readInfoFile(mountPoint);
    if (info) {
      console.log('\nINFO_UF2.TXT contents:\n');
      console.log(info);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}

