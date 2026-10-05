# raspimcu

`raspimcu` is a Node.js library and CLI for working with Raspberry Pi microcontroller boards such as the Pico. It helps you discover devices, move files to and from mounted UF2 volumes, switch boards into filesystem (BOOTSEL) mode, and manage firmware images.

## Features

- List connected Raspberry Pi MCUs and report whether they are in serial or filesystem mode.
- Copy files and directories on genuine mounted filesystems, with path and symlink checks.
- Upload, download, or execute commands on Raspberry Pi boards running MicroPython via [`mpremote`](https://docs.micropython.org/en/latest/reference/mpremote.html).
- Reboot a device into filesystem mode via [`picotool`](https://github.com/raspberrypi/picotool).
- Validate and copy RP2040 UF2 firmware to a BOOTSEL volume; back up flash through `picotool`.
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

- Node.js 22.12.0 or newer (the CLI uses import attributes; CI tests the minimum and Node 24).
- [`picotool`](https://github.com/raspberrypi/picotool) in your `PATH` for rebooting boards into filesystem mode.
- [`mpremote`](https://docs.micropython.org/en/latest/reference/mpremote.html) in your `PATH` for interacting with MicroPython firmware.
- Access to mounted BOOTSEL volumes for firmware upload (e.g. `/Volumes/RPI-RP2`, `/media/<user>/RPI-RP2`, `/run/media/<user>/RPI-RP2`).

## Choose the right device mode

The RP2040 BOOTSEL drive is a **virtual firmware-loading interface**, not a normal persistent filesystem. Use `firmware upload` for validated RP2040 UF2 images; use `micropython upload`/`download` for scripts and other persistent files. Generic `push`/`pull` reject BOOTSEL volumes instead of claiming ordinary files were saved there.

Firmware upload accepts flash images for family ID `0xe48bff56`, with 512-byte UF2 blocks, aligned 256-byte payloads, complete unique block numbering, nonoverlapping addresses in the RP2040 flash window, and only the family-present flag. Images are limited to 32 MiB of UF2 data (16 MiB payload address space); RAM images, RP2350 images, and extended flags are rejected. Upload requires root-level `INFO_UF2.TXT` declaring `Board-ID: RPI-RP2`, and the destination must be a root-level filename. Validation reads one block at a time rather than buffering the whole image.

To read flash back, use `firmware backup`, which calls `picotool save -a` over USB. The BOOTSEL drive does not expose your installed firmware as a normal `.uf2` file. The existing `firmware download` helper only copies an already-present UF2 file from genuine storage; it is **not** flash extraction.

## CLI Usage

List detected boards:

```bash
raspimcu devices
```

Reboot a specific board into filesystem mode using `picotool`:

```bash
raspimcu put-fs --serial E6606603B7313128 --wait-mount "/media/$USER/RPI-RP2"
```

Omit `--wait-mount` to send the reboot command without claiming mount readiness. The supplied wait path must be the intended board's path; metadata proves a compatible volume is present, not its USB serial identity. `--drive` is not a picotool selector and is now rejected; use `--serial` or `--bus`/`--address`. Forced reboot requires compatible running firmware; otherwise enter BOOTSEL manually.

Copy validated firmware onto the BOOTSEL drive:

```bash
raspimcu firmware upload firmware.uf2 /Volumes/RPI-RP2
```

Copy files on a genuine persistent filesystem (not BOOTSEL):

```bash
raspimcu push notes.txt /media/storage
raspimcu pull /media/storage logs.txt ./logs.txt
```

Upload firmware with a custom filename:

```bash
raspimcu firmware upload firmware.uf2 /Volumes/RPI-RP2 --name pico.uf2
```

Back up the device's flash while it is in BOOTSEL mode:

```bash
raspimcu firmware backup ./backup.uf2 --serial E6606603B7313128
```

Existing backups are protected unless you pass `--overwrite`. Extraction is staged locally, and a failed command does not replace the previous backup. Use `--force` only when you intend to let picotool reboot compatible running firmware. Backups can contain sensitive files or configuration; keep them private.

The backup's parent directory must already exist on a persistent filesystem. BOOTSEL destinations are rejected. Publication uses a same-filesystem rename with `--overwrite`, or a hard link without it to avoid overwriting a concurrently created file. Without `--overwrite`, hard-link support is checked before running picotool; unsupported filesystems fail safely before extraction rather than weakening that protection.

To copy an existing UF2 file from genuine storage instead, use `raspimcu firmware download /media/storage ./copy.uf2 --name firmware.uf2`. Omit `--name` only when exactly one UF2 file is available.

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

### Timeouts and discovery

`--timeout <ms>` accepts a positive integer up to 2147483647. Defaults: picotool reboot/version 10000 ms; flash backup and MicroPython transfers 60000 ms; noninteractive `repl --exec` 30000 ms. Interactive REPL has no default timeout. Explicit `--exec ""` remains noninteractive. Firmware writes are never automatically retried.

`put-fs --wait-mount <path>` has a separate `--wait-timeout <ms>` (default 10000). A timeout is an error, not evidence that a reboot or write did not occur; inspect device state before retrying.

Serial and storage discovery run concurrently. Filesystem traversal is bounded, includes Linux per-user mounts, avoids directory symlinks, and reports I/O/permission errors. Library callers can provide `searchRoots`; inspect `errors` as well as `devices`. Missing default roots are normal, not errors.

`findMountedBoards(searchRoots, { maxDepth: 2, concurrency: 4, errors })` returns an array sorted by mount path and appends storage diagnostics to the optional `errors` array. `listDevices` accepts the same depth/concurrency options and includes diagnostics in its result. The depth limit is relative to each search root; do not use a broad recursive scan of the whole filesystem.

## Library Usage

```js
import {
  listDevices,
  copyToDevice,
  copyFromDevice,
  putDeviceInFsMode,
  waitForMountedBoard,
  uploadFirmware,
  downloadFirmware,
  backupFirmware,
  readInfoFile,
  uploadToMicropython,
  downloadFromMicropython
} from 'raspimcu';

async function flashFirmware() {
  const { devices } = await listDevices();
  console.log(devices);

  // Use an explicit device identity; do not arbitrarily choose the first board.
  await putDeviceInFsMode({ serialNumber: 'E6606603B7313128' });
  await waitForMountedBoard('/Volumes/RPI-RP2');

  // Copy a UF2 once the device exposes a mount point.
  await uploadFirmware('./firmware.uf2', '/Volumes/RPI-RP2');
}

async function syncScripts(serialPath) {
  await uploadToMicropython(serialPath, './src', 'lib');
  await downloadFromMicropython(serialPath, 'main.py', './backups/main.py');
}
```

Each helper throws descriptive errors when paths are missing or commands fail, making it straightforward to compose your own workflows.

`backupFirmware('./backup.uf2', { serialNumber, timeout, overwrite: false })` returns `{ destination, output }`. `downloadFirmware(mountPoint, destination, { filename })` retains its file-copy return value `{ source, destination }` but rejects BOOTSEL. Recursive MicroPython downloads create the destination parent directory if missing: `downloadFromMicropython(port, '/lib', './backups', { recursive: true })` consistently updates `./backups/lib`, including the first call, rather than nesting another `lib`.

Safety checks reject symlinks in device paths instead of following them. They are not an OS-level sandbox against a hostile process changing files between validation and I/O. A successful UF2 copy is not a readback verification that the flashed application boots correctly. No physical flash-size inference is made from `INFO_UF2.TXT`; use firmware built for your board.

## Automated Tests

### Migration notes

- Upgrade Node to 22.12.0 or newer before using this version.
- Replace `push firmware.uf2 ...` with `firmware upload ...` for BOOTSEL; use mpremote for scripts.
- Replace BOOTSEL `firmware download` workflows with `firmware backup` to extract flash.
- Recursive MicroPython downloads treat the destination as a parent directory, whether it exists yet or not. Downloading `/lib` into `./backups` consistently places files under `./backups/lib`.
- Batch operations now time out by default; set a larger positive `--timeout` for long transfers or execution. Interactive REPL remains unlimited unless explicitly bounded.

### Running the suite

This project uses [Vitest](https://vitest.dev/) for unit testing. Run the full suite with:

```bash
npm ci --include=dev
npm test
```

Tests use temporary directories, synthetic UF2 fixtures, and fake subprocesses/serial enumeration. They cover path escapes, discovery errors/concurrency, command arguments and deadlines, backup failure cleanup, CLI parsing and mode semantics without accessing physical devices. CI is configured for Linux, macOS, and Windows. Passing these tests is not a substitute for a controlled hardware flash/backup test.

Run `node scripts/benchmark-discovery.js` for a reproducible synthetic fixture with per-user mount paths. It checks detected boards and reports first-pass/warm timings; it does not flush OS caches or measure physical-board latency.

## Manual Firmware Test Scripts

The `manual-tests` folder contains opt-in scripts. The upload script writes real hardware when pointed at a board; the download script copies a preexisting file from genuine storage, not the BOOTSEL volume:

- `node manual-tests/upload-firmware.js <firmware.uf2> <mount-point> [target-name.uf2]`
- `node manual-tests/download-firmware.js <storage-directory> <destination.uf2> [filename.uf2]`

Both scripts print results and propagate validation errors. Use the `firmware backup` CLI above for actual device flash extraction.

## License

Licensed under the [MIT License](LICENSE).
