import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import pkg from '../package.json' with { type: 'json' };
import {
  listDevices,
  getSingleDevice,
  putDeviceInFsMode,
  rebootToBootsel,
  BOOTSEL_METHODS,
  waitForMountedBoard,
  copyToDevice,
  copyFromDevice,
  uploadFirmware,
  downloadFirmware,
  backupFirmware,
  readInfoFile,
  uploadToMicropython,
  downloadFromMicropython,
  runMicropythonRepl
} from './index.js';

function parseCliTimeout(value) {
  const timeout = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) {
    throw new InvalidArgumentError('Timeout must be an integer from 1 to 2147483647 milliseconds.');
  }
  return timeout;
}

function parseCliMethods(value) {
  const methods = value.split(',').map((method) => method.trim()).filter(Boolean);
  const unknown = methods.filter((method) => !BOOTSEL_METHODS.includes(method));
  if (!methods.length || unknown.length || new Set(methods).size !== methods.length) {
    throw new InvalidArgumentError(`Methods must be a comma-separated list of distinct values from: ${BOOTSEL_METHODS.join(', ')}.`);
  }
  return methods;
}

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
      errors: result.errors.map((item) => ({
        source: item.source,
        message: item.error?.message || 'Unknown error'
      })),
      generatedAt: new Date().toISOString()
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  renderDevicesTable(result.devices);
  if (result.errors.length) {
    console.log(chalk.yellow('Warnings:'));
    for (const entry of result.errors) {
      const message = entry.error?.message || 'Unknown error';
      console.log(`  [${entry.source}] ${message}`);
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
    .description('Reboot a device into filesystem (BOOTSEL) mode via picotool, or over serial with --port.')
    .option('-s, --serial <serialNumber>', 'Target a specific device serial number')
    .option('-b, --bus <bus>', 'USB bus number')
    .option('-a, --address <address>', 'USB device address on the bus')
    .option('-d, --drive <drive>', 'Unsupported legacy selector; use --serial or --bus/--address')
    .option('-p, --picotool <path>', 'Custom picotool executable path')
    .option('--port <path>', 'Serial port of the running board; tries the REPL and 1200-baud touch before picotool')
    .option('--methods <list>', `Ordered BOOTSEL methods to try (default: ${BOOTSEL_METHODS.join(',')})`, parseCliMethods)
    .option('-t, --timeout <ms>', 'Command timeout in milliseconds (total across methods with --port/--methods)', parseCliTimeout)
    .option('--wait-mount <path>', 'Verify this explicit RP2040 BOOTSEL mount after reboot')
    .option('--wait-timeout <ms>', 'Mount wait timeout in milliseconds (default: 10000)', parseCliTimeout)
    .action(async (options) => {
      try {
        let { serial: serialNumber, bus, address, drive, port: serialPath } = options;
        if (drive !== undefined) {
          throw new Error('--drive is not supported by picotool. Use --serial or --bus/--address.');
        }

        // Auto-select device when no targeting options provided
        const noTargetSpecified = !serialNumber && bus === undefined && address === undefined && !drive && !serialPath;
        if (noTargetSpecified) {
          const { device, error } = await getSingleDevice({ type: 'serial' });
          if (error) {
            throw new Error(error);
          }
          if (!device?.serialNumber) {
            throw new Error('Cannot safely select this device. Provide an explicit --serial or --bus/--address.');
          }
          serialNumber = device.serialNumber;
          if (options.methods) serialPath = device.path;
          console.log(chalk.dim(`Auto-selected device: ${device.path || device.id}`));
        }

        let output;
        if (serialPath || options.methods) {
          const result = await rebootToBootsel({
            path: serialPath,
            serialNumber,
            bus,
            address,
            picotoolPath: options.picotool,
            timeout: options.timeout,
            methods: options.methods
          });
          console.log(chalk.dim(`Reboot method: ${result.method}`));
          output = result.output;
        } else {
          output = await putDeviceInFsMode({
            serialNumber,
            bus,
            address,
            drive,
            picotoolPath: options.picotool,
            timeout: options.timeout
          });
        }
        if (output) {
          console.log(output);
        }
        if (options.waitMount) {
          const board = await waitForMountedBoard(options.waitMount, { timeout: options.waitTimeout });
          console.log(`BOOTSEL mount verified at ${board.mountPoint}`);
        } else {
          console.log('Reboot command sent; mount readiness not verified. Use --wait-mount <path> to verify.');
        }
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  program
    .command('push <source> <mountPoint> [targetPath]')
    .description('Copy to a genuine mounted filesystem (not a BOOTSEL virtual drive).')
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
    .description('Copy from a genuine mounted filesystem (not a BOOTSEL virtual drive).')
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
        console.log(`UF2 copied to ${destination}; device flash/boot not verified.`);
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  firmwareCmd
    .command('download <mountPoint> <destination>')
    .description('Copy an existing UF2 file from genuine storage; use backup to extract flash.')
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
    .command('backup <destination>')
    .description('Back up flash to UF2 using picotool (not the virtual boot drive).')
    .option('-s, --serial <serialNumber>', 'Target a specific device serial number')
    .option('-b, --bus <bus>', 'USB bus number')
    .option('-a, --address <address>', 'USB device address on the bus')
    .option('-p, --picotool <path>', 'Custom picotool executable path')
    .option('-t, --timeout <ms>', 'Command timeout in milliseconds (default: 60000)', parseCliTimeout)
    .option('--overwrite', 'Replace an existing local backup only after successful extraction', false)
    .option('--force', 'Allow picotool to reboot compatible running firmware for backup', false)
    .action(async (destination, options) => {
      try {
        const result = await backupFirmware(destination, {
          serialNumber: options.serial,
          bus: options.bus,
          address: options.address,
          picotoolPath: options.picotool,
          timeout: options.timeout,
          overwrite: options.overwrite,
          force: options.force
        });
        if (result.output) {
          console.log(result.output);
        }
        console.log(`Flash backup saved to ${result.destination}`);
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

  const micropythonCmd = program
    .command('micropython')
    .description('Work with Raspberry Pi boards running MicroPython via mpremote.');

  micropythonCmd
    .command('upload <serialPath> <source> <target>')
    .description('Upload a file or directory to a MicroPython device.')
    .option('-m, --mpremote <path>', 'Custom mpremote executable path')
    .option('-t, --timeout <ms>', 'Command timeout in milliseconds', parseCliTimeout)
    .action(async (serialPath, source, target, options) => {
      try {
        const result = await uploadToMicropython(serialPath, source, target, {
          mpremotePath: options.mpremote,
          timeout: options.timeout
        });
        console.log(`Uploaded ${result.source} -> ${result.target}`);
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  micropythonCmd
    .command('download <serialPath> <remotePath> <destination>')
    .description('Download a file or directory from a MicroPython device.')
    .option('-r, --recursive', 'Copy directories recursively')
    .option('-m, --mpremote <path>', 'Custom mpremote executable path')
    .option('-t, --timeout <ms>', 'Command timeout in milliseconds', parseCliTimeout)
    .action(async (serialPath, remotePath, destination, options) => {
      try {
        const result = await downloadFromMicropython(serialPath, remotePath, destination, {
          mpremotePath: options.mpremote,
          recursive: options.recursive,
          timeout: options.timeout
        });
        console.log(`Downloaded ${result.source} -> ${result.destination}`);
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  micropythonCmd
    .command('repl <serialPath>')
    .description('Open an interactive REPL or execute a command on a MicroPython device.')
    .option('-e, --exec <code>', 'Execute code on the device instead of opening an interactive REPL')
    .option('-m, --mpremote <path>', 'Custom mpremote executable path')
    .option('-t, --timeout <ms>', 'Command timeout in milliseconds', parseCliTimeout)
    .action(async (serialPath, options) => {
      try {
        const result = await runMicropythonRepl(serialPath, {
          mpremotePath: options.mpremote,
          code: options.exec,
          timeout: options.timeout
        });
        if (typeof result === 'string' && result.trim()) {
          console.log(result.trim());
        }
      } catch (error) {
        logError(error);
        process.exitCode = 1;
      }
    });

  await program.parseAsync(argv);
}

export { runCli };
