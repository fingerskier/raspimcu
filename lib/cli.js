const { Command } = require('commander');
const chalk = require('chalk');
const pkg = require('../package.json');
const {
  listDevices,
  putDeviceInFsMode,
  copyToDevice,
  copyFromDevice,
  uploadFirmware,
  downloadFirmware,
  readInfoFile
} = require('./index');

function logError(error) {
  if (error instanceof Error) {
    console.error(chalk.red(error.message));
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
  } else {
    console.error(chalk.red(String(error)));
  }
}

function renderDevicesTable(devices) {
  if (!devices.length) {
    console.log('No Raspberry Pi MCUs detected.');
    return;
  }

  for (const device of devices) {
    console.log(chalk.cyan(device.id));
    console.log(`  type: ${device.type}`);
    console.log(`  status: ${device.status}`);
    if (device.path) {
      console.log(`  path: ${device.path}`);
    }
    if (device.mountPoint) {
      console.log(`  mount: ${device.mountPoint}`);
    }
    if (device.manufacturer) {
      console.log(`  manufacturer: ${device.manufacturer}`);
    }
    if (device.serialNumber) {
      console.log(`  serial: ${device.serialNumber}`);
    }
    if (device.boardId) {
      console.log(`  boardId: ${device.boardId}`);
    }
    if (device.model) {
      console.log(`  model: ${device.model}`);
    }
    if (device.description) {
      console.log(`  description: ${device.description}`);
    }
    console.log('');
  }
}

async function handleDevicesCommand(options) {
  const result = await listDevices();
  if (options.json) {
    const payload = {
      devices: result.devices,
      errors: result.errors.map((item) => ({ source: item.source, message: item.error.message })),
      generatedAt: new Date().toISOString()
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  renderDevicesTable(result.devices);
  if (result.errors.length) {
    console.log(chalk.yellow('Warnings:'));
    for (const entry of result.errors) {
      console.log(`  [${entry.source}] ${entry.error.message}`);
    }
  }
}

async function runCli(argv = process.argv) {
  const program = new Command();
  program
    .name('raspimcu')
    .description('Manage Raspberry Pi microcontroller boards from the CLI or Node.js scripts.')
    .version(pkg.version);

  program
    .command('devices')
    .description('List connected Raspberry Pi MCUs and their status.')
    .option('--json', 'Output device information as JSON')
    .action((options) => handleDevicesCommand(options).catch((error) => {
      logError(error);
      process.exitCode = 1;
    }));

  program
    .command('put-fs')
    .description('Use picotool to reboot a device into filesystem (BOOTSEL) mode.')
    .option('-s, --serial <serialNumber>', 'Target a specific device serial number')
    .option('-b, --bus <bus>', 'USB bus number')
    .option('-a, --address <address>', 'USB device address on the bus')
    .option('-d, --drive <drive>', 'Explicit drive name for picotool')
    .option('-p, --picotool <path>', 'Custom picotool executable path')
    .action(async (options) => {
      try {
        const output = await putDeviceInFsMode({
          serialNumber: options.serial,
          bus: options.bus,
          address: options.address,
          drive: options.drive,
          picotoolPath: options.picotool
        });
        if (output) {
          console.log(output);
        }
        console.log('Reboot command sent. Check your mounted volumes for the UF2 drive.');
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  program
    .command('push <source> <mountPoint> [targetPath]')
    .description('Copy a file or directory to a device mounted in filesystem mode.')
    .action(async (source, mountPoint, targetPath) => {
      try {
        const destination = await copyToDevice(source, mountPoint, { targetPath });
        console.log(`Copied ${source} -> ${destination}`);
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  program
    .command('pull <mountPoint> <sourcePath> <destination>')
    .description('Copy a file or directory from the device to the local machine.')
    .action(async (mountPoint, sourcePath, destination) => {
      try {
        const resolved = await copyFromDevice(mountPoint, sourcePath, destination);
        console.log(`Copied ${sourcePath} -> ${resolved}`);
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  const firmwareCmd = program
    .command('firmware')
    .description('Manage UF2 firmware images on Raspberry Pi MCUs.');

  firmwareCmd
    .command('upload <firmwarePath> <mountPoint>')
    .description('Upload a UF2 firmware image to the device.')
    .option('-n, --name <filename>', 'Rename the firmware file on the device')
    .action(async (firmwarePath, mountPoint, options) => {
      try {
        const destination = await uploadFirmware(firmwarePath, mountPoint, { targetFilename: options.name });
        console.log(`Firmware uploaded to ${destination}`);
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  firmwareCmd
    .command('download <mountPoint> <destination>')
    .description('Download a UF2 firmware image from the device to the local machine.')
    .option('-n, --name <filename>', 'Firmware filename on the device (auto-detected if omitted)')
    .action(async (mountPoint, destination, options) => {
      try {
        const result = await downloadFirmware(mountPoint, destination, { filename: options.name });
        console.log(`Firmware ${result.source} saved to ${result.destination}`);
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  firmwareCmd
    .command('info <mountPoint>')
    .description('Read the INFO_UF2.TXT metadata from a mounted device.')
    .action(async (mountPoint) => {
      try {
        const info = await readInfoFile(mountPoint);
        if (info) {
          console.log(info);
        } else {
          console.log('INFO_UF2.TXT not found. Make sure the device is in filesystem mode.');
        }
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  await program.parseAsync(argv);
}

module.exports = {
  runCli
};
