import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { uploadFirmware, downloadFirmware, readInfoFile } from '../lib/firmware.js';

const tmpRoot = path.join(os.tmpdir(), 'raspimcu-tests');

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
    await fs.writeFile(firmwarePath, 'mock firmware');

    const destination = await uploadFirmware(firmwarePath, mountDir, {
      targetFilename: 'pico-custom.uf2',
    });

    expect(destination).toBe(path.join(mountDir, 'pico-custom.uf2'));
    const exists = await fs.pathExists(destination);
    expect(exists).toBe(true);
    const contents = await fs.readFile(destination, 'utf8');
    expect(contents).toBe('mock firmware');
  });

  it('throws when uploading a non-existent firmware path', async () => {
    await expect(uploadFirmware('/does/not/exist.uf2', mountDir)).rejects.toThrow(
      'Firmware file not found: /does/not/exist.uf2',
    );
  });

  it('downloads the first UF2 file when filename omitted', async () => {
    const firmwarePath = path.join(mountDir, 'device.uf2');
    await fs.writeFile(firmwarePath, 'device firmware');
    const destinationDir = await createTempDir('downloads-');

    try {
      const { source, destination } = await downloadFirmware(mountDir, path.join(destinationDir, 'output.uf2'));
      expect(source).toBe('device.uf2');
      expect(await fs.pathExists(destination)).toBe(true);
      const contents = await fs.readFile(destination, 'utf8');
      expect(contents).toBe('device firmware');
    } finally {
      await cleanupTempDir(destinationDir);
    }
  });

  it('throws when no UF2 file is available on the device', async () => {
    const destinationDir = await createTempDir('downloads-');
    try {
      await expect(
        downloadFirmware(mountDir, path.join(destinationDir, 'output.uf2')),
      ).rejects.toThrow('No UF2 firmware file found on the device');
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

