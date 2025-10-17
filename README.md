# raspimcu

`raspimcu` is a Node.js library and CLI for working with Raspberry Pi microcontroller boards such as the Pico. It helps you discover devices, move files to and from mounted UF2 volumes, switch boards into filesystem (BOOTSEL) mode, and manage firmware images.

## Features

- List connected Raspberry Pi MCUs and report whether they are in serial or filesystem mode.
- Copy files and directories to and from mounted UF2 storage volumes.
- Upload, download, or execute commands on Raspberry Pi boards running MicroPython via [`mpremote`](https://docs.micropython.org/en/latest/reference/mpremote.html).
- Reboot a device into filesystem mode via [`picotool`](https://github.com/raspberrypi/picotool).
- Upload or download UF2 firmware images from a mounted board.
- Works as both a Node.js module and an `npx`-friendly CLI.

## Installation

```bash
npm install raspimcu
```

or run the CLI via `npx` without installing globally:

```bash
npx raspimcu devices
```

## Requirements

- Node.js 18 or newer.
- [`picotool`](https://github.com/raspberrypi/picotool) in your `PATH` for rebooting boards into filesystem mode.
- [`mpremote`](https://docs.micropython.org/en/latest/reference/mpremote.html) in your `PATH` for interacting with MicroPython firmware.
- Access to mounted UF2 volumes created by Raspberry Pi MCUs (e.g. `/Volumes/RPI-RP2`, `/media/<user>/RPI-RP2`).

## CLI Usage

List detected boards:

```bash
raspimcu devices
```

Reboot a specific board into filesystem mode using `picotool`:

```bash
raspimcu put-fs --serial E6606603B7313128
```

Copy a file onto the mounted UF2 drive:

```bash
raspimcu push firmware.uf2 /Volumes/RPI-RP2
```

Copy files from the device back to your machine:

```bash
raspimcu pull /Volumes/RPI-RP2 logs.txt ./logs.txt
```

Upload firmware with a custom filename:

```bash
raspimcu firmware upload firmware.uf2 /Volumes/RPI-RP2 --name pico.uf2
```

Download firmware from the device (auto-detects the first UF2 file if you do not specify `--name`):

```bash
raspimcu firmware download /Volumes/RPI-RP2 ./downloaded.uf2
```

Inspect the `INFO_UF2.TXT` metadata from a mounted board:

```bash
raspimcu firmware info /Volumes/RPI-RP2
```

Upload a file to a MicroPython-enabled board over serial:

```bash
raspimcu micropython upload /dev/ttyACM0 ./main.py main.py
```

Download a file (or directory with `--recursive`) from the board:

```bash
raspimcu micropython download /dev/ttyACM0 main.py ./backups/main.py
```

Run a one-off REPL command (omit `--exec` for an interactive session):

```bash
raspimcu micropython repl /dev/ttyACM0 --exec "import os; print(os.listdir())"
```

Use `raspimcu devices --json` to integrate the discovery output into other tooling.

## Library Usage

```js
import {
  listDevices,
  copyToDevice,
  copyFromDevice,
  putDeviceInFsMode,
  uploadFirmware,
  downloadFirmware,
  readInfoFile,
  uploadToMicropython,
  downloadFromMicropython
} from 'raspimcu';

async function flashFirmware() {
  const { devices } = await listDevices();
  console.log(devices);

  // Reboot the first serial device into filesystem mode.
  if (devices.length && devices[0].type === 'serial') {
    await putDeviceInFsMode({ serialNumber: devices[0].serialNumber });
  }

  // Copy a UF2 once the device exposes a mount point.
  await uploadFirmware('./firmware.uf2', '/Volumes/RPI-RP2');
}

async function syncScripts(serialPath) {
  await uploadToMicropython(serialPath, './src', 'lib');
  await downloadFromMicropython(serialPath, 'main.py', './backups/main.py');
}
```

Each helper throws descriptive errors when paths are missing or commands fail, making it straightforward to compose your own workflows.

## License

Licensed under the [MIT License](LICENSE).
