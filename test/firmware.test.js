import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { uploadFirmware, downloadFirmware, readInfoFile, validateUf2, MAX_UF2_BYTES } from '../lib/firmware.js';
import { makeUf2, RP2040_INFO } from './uf2Fixture.js';

const tmpRoot = path.join(fs.realpathSync(os.tmpdir()), 'raspimcu-tests');

async function createTempDir(prefix) {
  await fs.ensureDir(tmpRoot);
  return await fs.mkdtemp(path.join(tmpRoot, prefix));
}

async function cleanupTempDir(dir) {
  if (dir && dir.startsWith(tmpRoot)) {
    await fs.remove(dir);
  }
}

describe('firmware utilities', () => {
  let firmwareDir;
  let mountDir;

  beforeEach(async () => {
    firmwareDir = await createTempDir('firmware-');
    mountDir = await createTempDir('mount-');
  });

  afterEach(async () => {
    await cleanupTempDir(firmwareDir);
    await cleanupTempDir(mountDir);
  });

  it('uploads a UF2 firmware file to the mount point', async () => {
    const firmwarePath = path.join(firmwareDir, 'pico.uf2');
    await fs.writeFile(firmwarePath, makeUf2());
    await fs.writeFile(path.join(mountDir, 'INFO_UF2.TXT'), RP2040_INFO);

    const destination = await uploadFirmware(firmwarePath, mountDir, {
      targetFilename: 'pico-custom.uf2',
    });

    expect(destination).toBe(path.join(mountDir, 'pico-custom.uf2'));
    const exists = await fs.pathExists(destination);
    expect(exists).toBe(true);
    const contents = await fs.readFile(destination);
    expect(contents).toEqual(makeUf2());
  });

  it('validates and transfers firmware through trusted parent aliases', async () => {
    const parent = path.join(firmwareDir, 'real');
    const alias = path.join(firmwareDir, 'alias');
    await fs.ensureDir(path.join(parent, 'device'));
    await fs.writeFile(path.join(parent, 'pico.uf2'), makeUf2());
    await fs.writeFile(path.join(parent, 'device', 'INFO_UF2.TXT'), RP2040_INFO);
    await fs.symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const mount = path.join(alias, 'device');
    expect((await validateUf2(path.join(alias, 'pico.uf2'))).blockCount).toBe(2);
    expect(await uploadFirmware(path.join(alias, 'pico.uf2'), mount)).toBe(path.join(parent, 'device', 'pico.uf2'));
    expect(await readInfoFile(mount)).toBe(RP2040_INFO.trim());
    await fs.remove(path.join(parent, 'device', 'INFO_UF2.TXT'));
    expect(await downloadFirmware(mount, path.join(alias, 'new', 'out.uf2')))
      .toEqual({ source: 'pico.uf2', destination: path.join(parent, 'new', 'out.uf2') });
    expect(await fs.readFile(path.join(parent, 'new', 'out.uf2'))).toEqual(makeUf2());
    await fs.symlink(parent, path.join(mount, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(downloadFirmware(mount, path.join(parent, 'out.uf2'), { filename: 'escape/pico.uf2' })).rejects.toThrow(/symlink/i);
  });

  it('rejects fake UF2 contents before touching the destination', async () => {
    const firmwarePath = path.join(firmwareDir, 'pico.uf2');
    await fs.writeFile(firmwarePath, 'fake firmware');
    await fs.writeFile(path.join(mountDir, 'INFO_UF2.TXT'), RP2040_INFO);
    await fs.writeFile(path.join(mountDir, 'pico.uf2'), 'preserve');
    await expect(uploadFirmware(firmwarePath, mountDir)).rejects.toThrow(/UF2/i);
    expect(await fs.readFile(path.join(mountDir, 'pico.uf2'), 'utf8')).toBe('preserve');
  });

  it.each([
    ['start magic', 0, 0], ['second magic', 4, 0], ['end magic', 508, 0],
    ['family', 28, 0xe48bff59], ['missing family flag', 8, 0], ['unsupported flags', 8, 0x2001],
    ['payload size', 16, 512], ['zero payload', 16, 0], ['unaligned payload', 16, 255],
    ['count mismatch', 24, 3], ['zero count', 24, 0], ['duplicate block', 512 + 20, 0],
    ['out of range block', 20, 2], ['below flash', 12, 0x0fffff00],
    ['beyond flash', 12, 0x11000000], ['unaligned address', 12, 0x10000001],
    ['overlapping addresses', 512 + 12, 0x10000000],
  ])('rejects UF2 %s before destination write', async (_label, offset, value) => {
    const image = makeUf2();
    image.writeUInt32LE(value, offset);
    const source = path.join(firmwareDir, 'pico.uf2');
    await fs.writeFile(source, image);
    await fs.writeFile(path.join(mountDir, 'INFO_UF2.TXT'), RP2040_INFO);
    await expect(uploadFirmware(source, mountDir)).rejects.toThrow(/UF2/i);
    expect(await fs.pathExists(path.join(mountDir, 'pico.uf2'))).toBe(false);
  });

  it('accepts complete out-of-order blocks', async () => {
    const image = makeUf2();
    const source = path.join(firmwareDir, 'pico.uf2');
    await fs.writeFile(source, Buffer.concat([image.subarray(512), image.subarray(0, 512)]));
    await fs.writeFile(path.join(mountDir, 'INFO_UF2.TXT'), RP2040_INFO);
    expect(await uploadFirmware(source, mountDir)).toBe(path.join(mountDir, 'pico.uf2'));
  });

  it.each([null, 'UF2 Bootloader\nBoard-ID: OTHER-RP2040\n', 'UF2 Bootloader\nBoard-ID: RPI-RP2350\n', 'Model: RP2040\n'])('requires RP2040 INFO_UF2 board identity (%s)', async (info) => {
    const source = path.join(firmwareDir, 'pico.uf2');
    await fs.writeFile(source, makeUf2());
    if (info) await fs.writeFile(path.join(mountDir, 'INFO_UF2.TXT'), info);
    await expect(uploadFirmware(source, mountDir)).rejects.toThrow(/RP2040.*INFO_UF2|INFO_UF2.*RP2040/i);
    expect(await fs.pathExists(path.join(mountDir, 'pico.uf2'))).toBe(false);
  });

  it.each(['nested/pico.uf2', './pico.uf2', '../outside.uf2', 'nested\\pico.uf2'])('rejects non-root firmware filename %s', async (targetFilename) => {
    const source = path.join(firmwareDir, 'pico.uf2');
    await fs.writeFile(source, makeUf2());
    await fs.writeFile(path.join(mountDir, 'INFO_UF2.TXT'), RP2040_INFO);
    await expect(uploadFirmware(source, mountDir, { targetFilename })).rejects.toThrow(/root.*filename/i);
    expect(await fs.readdir(mountDir)).toEqual(['INFO_UF2.TXT']);
  });

  it.each(['source', 'destination', 'info'])('rejects firmware %s symlinks', async (kind) => {
    const source = path.join(firmwareDir, 'pico.uf2');
    const realSource = path.join(firmwareDir, 'real.uf2');
    await fs.writeFile(realSource, makeUf2());
    if (kind === 'source') await fs.symlink(realSource, source);
    else await fs.copy(realSource, source);
    const info = path.join(mountDir, 'INFO_UF2.TXT');
    if (kind === 'info') {
      await fs.writeFile(path.join(firmwareDir, 'info'), RP2040_INFO);
      await fs.symlink(path.join(firmwareDir, 'info'), info);
    } else await fs.writeFile(info, RP2040_INFO);
    if (kind === 'destination') await fs.symlink(realSource, path.join(mountDir, 'pico.uf2'));
    await expect(uploadFirmware(source, mountDir)).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(realSource)).toEqual(makeUf2());
  });

  it('reports bounded-validator metadata and rejects oversize sparse files', async () => {
    const source = path.join(firmwareDir, 'pico.uf2');
    await fs.writeFile(source, makeUf2());
    expect(await validateUf2(source)).toEqual({ blockCount: 2, size: 1024, familyId: 0xe48bff56 });
    await fs.truncate(source, MAX_UF2_BYTES + 512);
    await expect(validateUf2(source)).rejects.toThrow(/32 MiB/);
  });

  it.each([0, 513, 1023])('rejects incomplete UF2 length %s', async (size) => {
    const source = path.join(firmwareDir, 'pico.uf2');
    await fs.writeFile(source, makeUf2().subarray(0, size));
    await expect(validateUf2(source)).rejects.toThrow(/UF2/);
  });

  it('validates the final block before overwriting an existing target', async () => {
    const source = path.join(firmwareDir, 'pico.uf2');
    const image = makeUf2();
    image.writeUInt32LE(0, image.length - 4);
    await fs.writeFile(source, image);
    await fs.writeFile(path.join(mountDir, 'INFO_UF2.TXT'), RP2040_INFO);
    await fs.writeFile(path.join(mountDir, 'pico.uf2'), 'untouched');
    await expect(uploadFirmware(source, mountDir)).rejects.toThrow(/UF2/);
    expect(await fs.readFile(path.join(mountDir, 'pico.uf2'), 'utf8')).toBe('untouched');
  });

  it('bounds INFO_UF2 metadata reads', async () => {
    await fs.writeFile(path.join(mountDir, 'INFO_UF2.TXT'), RP2040_INFO + 'x'.repeat(65536));
    await expect(readInfoFile(mountDir)).rejects.toThrow(/INFO_UF2.*(large|64 KiB)/i);
  });

  it('throws when uploading a non-existent firmware path', async () => {
    await expect(uploadFirmware('/does/not/exist.uf2', mountDir)).rejects.toThrow(
      'Firmware file not found: /does/not/exist.uf2',
    );
  });

  it('downloads the only UF2 file when filename omitted', async () => {
    const firmwarePath = path.join(mountDir, 'device.uf2');
    await fs.writeFile(firmwarePath, makeUf2());
    const destinationDir = await createTempDir('downloads-');

    try {
      const { source, destination } = await downloadFirmware(mountDir, path.join(destinationDir, 'output.uf2'));
      expect(source).toBe('device.uf2');
      expect(await fs.pathExists(destination)).toBe(true);
      const contents = await fs.readFile(destination);
      expect(contents).toEqual(makeUf2());
    } finally {
      await cleanupTempDir(destinationDir);
    }
  });

  it('rejects BOOTSEL downloads with real flash backup guidance', async () => {
    await fs.writeFile(path.join(mountDir, 'INFO_UF2.TXT'), RP2040_INFO);
    await fs.writeFile(path.join(mountDir, 'CURRENT.UF2'), makeUf2());
    const output = path.join(firmwareDir, 'out.uf2');
    await expect(downloadFirmware(mountDir, output)).rejects.toThrow(/BOOTSEL.*backupFirmware.*picotool/i);
    expect(await fs.pathExists(output)).toBe(false);
  });

  it('rejects nested BOOTSEL sources and BOOTSEL download destinations', async () => {
    await fs.ensureDir(path.join(mountDir, 'boot'));
    await fs.writeFile(path.join(mountDir, 'boot', 'INFO_UF2.TXT'), RP2040_INFO);
    await fs.writeFile(path.join(mountDir, 'boot', 'pico.uf2'), makeUf2());
    await expect(downloadFirmware(mountDir, path.join(firmwareDir, 'out.uf2'), { filename: 'boot/pico.uf2' })).rejects.toThrow(/BOOTSEL.*backupFirmware/);
    await fs.writeFile(path.join(mountDir, 'pico.uf2'), makeUf2());
    await fs.writeFile(path.join(firmwareDir, 'INFO_UF2.TXT'), RP2040_INFO);
    await expect(downloadFirmware(mountDir, path.join(firmwareDir, 'out.uf2'), { filename: 'pico.uf2' })).rejects.toThrow(/BOOTSEL/);
  });

  it('requires explicit filename for multiple stored UF2 candidates', async () => {
    await fs.writeFile(path.join(mountDir, 'a.uf2'), makeUf2());
    await fs.writeFile(path.join(mountDir, 'b.uf2'), makeUf2());
    const output = path.join(firmwareDir, 'out.uf2');
    await expect(downloadFirmware(mountDir, output)).rejects.toThrow(/multiple.*--name\b/i);
    expect(await fs.pathExists(output)).toBe(false);
    expect((await downloadFirmware(mountDir, output, { filename: 'b.uf2' })).source).toBe('b.uf2');
  });

  it.each(['source', 'destination'])('rejects stored firmware %s symlinks', async (kind) => {
    const realFile = path.join(firmwareDir, 'real.uf2');
    const output = path.join(firmwareDir, 'out.uf2');
    await fs.writeFile(realFile, makeUf2());
    if (kind === 'source') await fs.symlink(realFile, path.join(mountDir, 'a.uf2'));
    else {
      await fs.copy(realFile, path.join(mountDir, 'a.uf2'));
      await fs.symlink(realFile, output);
    }
    await expect(downloadFirmware(mountDir, output, { filename: 'a.uf2' })).rejects.toThrow(/symlink/i);
  });

  it('throws when no UF2 file is available on the device', async () => {
    const destinationDir = await createTempDir('downloads-');
    try {
      await expect(
        downloadFirmware(mountDir, path.join(destinationDir, 'output.uf2')),
      ).rejects.toThrow(/No UF2 firmware file found on the device.*--name\b/);
    } finally {
      await cleanupTempDir(destinationDir);
    }
  });

  it('reads the info file when present', async () => {
    const infoPath = path.join(mountDir, 'INFO_UF2.TXT');
    await fs.writeFile(infoPath, 'UF2 info\n');

    const info = await readInfoFile(mountDir);
    expect(info).toBe('UF2 info');
  });

  it('returns null when info file missing', async () => {
    const info = await readInfoFile(mountDir);
    expect(info).toBeNull();
  });
});

