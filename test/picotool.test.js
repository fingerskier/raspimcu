import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

vi.mock('execa', () => ({
  execa: vi.fn()
}));

import { execa } from 'execa';
import { putDeviceInFsMode, getPicotoolVersion } from '../lib/picotool.js';

describe('picotool wrapper', () => {
  let testDir;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picotool-test-'));
  });

  afterEach(async () => {
    if (testDir && await fs.pathExists(testDir)) {
      await fs.remove(testDir);
    }
  });

  describe('putDeviceInFsMode', () => {
    it('calls picotool with reboot -f arguments', async () => {
      execa.mockResolvedValue({ stdout: 'Rebooting device' });

      const result = await putDeviceInFsMode();

      expect(execa).toHaveBeenCalledWith('picotool', ['reboot', '-f'], { timeout: 10000 });
      expect(result).toBe('Rebooting device');
    });

    it('includes serial number when provided', async () => {
      execa.mockResolvedValue({ stdout: 'Rebooting' });

      await putDeviceInFsMode({ serialNumber: 'ABC123' });

      expect(execa).toHaveBeenCalledWith(
        'picotool',
        ['reboot', '-f', '--serial', 'ABC123'],
        { timeout: 10000 }
      );
    });

    it('includes bus and address when provided', async () => {
      execa.mockResolvedValue({ stdout: 'Rebooting' });

      await putDeviceInFsMode({ bus: 1, address: 2 });

      expect(execa).toHaveBeenCalledWith(
        'picotool',
        ['reboot', '-f', '--bus', '1', '--address', '2'],
        { timeout: 10000 }
      );
    });

    it('includes drive when provided', async () => {
      execa.mockResolvedValue({ stdout: 'Rebooting' });

      await putDeviceInFsMode({ drive: 'E:' });

      expect(execa).toHaveBeenCalledWith(
        'picotool',
        ['reboot', '-f', '--drive', 'E:'],
        { timeout: 10000 }
      );
    });

    it('uses custom timeout when provided', async () => {
      execa.mockResolvedValue({ stdout: 'Done' });

      await putDeviceInFsMode({ timeout: 5000 });

      expect(execa).toHaveBeenCalledWith('picotool', ['reboot', '-f'], { timeout: 5000 });
    });

    it('uses custom picotool path when provided', async () => {
      const customPath = path.join(testDir, 'custom-picotool');
      await fs.writeFile(customPath, '');
      execa.mockResolvedValue({ stdout: 'Done' });

      await putDeviceInFsMode({ picotoolPath: customPath });

      expect(execa).toHaveBeenCalledWith(customPath, ['reboot', '-f'], { timeout: 10000 });
    });

    it('throws when custom picotool path does not exist', async () => {
      await expect(
        putDeviceInFsMode({ picotoolPath: '/nonexistent/picotool' })
      ).rejects.toThrow('Specified picotool executable was not found');
    });

    it('throws friendly error when picotool not installed', async () => {
      const error = new Error('spawn picotool ENOENT');
      error.code = 'ENOENT';
      execa.mockRejectedValue(error);

      await expect(putDeviceInFsMode()).rejects.toThrow(
        'picotool is not installed or not available on the PATH'
      );
    });

    it('passes through other errors', async () => {
      const error = new Error('Device not found');
      execa.mockRejectedValue(error);

      await expect(putDeviceInFsMode()).rejects.toThrow('Device not found');
    });
  });

  describe('getPicotoolVersion', () => {
    it('returns picotool version output', async () => {
      execa.mockResolvedValue({ stdout: 'picotool v1.1.2\n' });

      const result = await getPicotoolVersion();

      expect(execa).toHaveBeenCalledWith('picotool', ['version']);
      expect(result).toBe('picotool v1.1.2');
    });

    it('throws friendly error when picotool not installed', async () => {
      const error = new Error('spawn picotool ENOENT');
      error.code = 'ENOENT';
      execa.mockRejectedValue(error);

      await expect(getPicotoolVersion()).rejects.toThrow(
        'picotool is not installed or not available on the PATH'
      );
    });
  });
});
