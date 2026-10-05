import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

vi.mock('execa', () => ({
  execa: vi.fn()
}));

import { execa } from 'execa';
import { putDeviceInFsMode, getPicotoolVersion, backupFirmware } from '../lib/picotool.js';

describe('picotool wrapper', () => {
  let testDir;

  beforeEach(async () => {
    vi.resetAllMocks();
    testDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'picotool-test-')));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (testDir && await fs.pathExists(testDir)) {
      await fs.remove(testDir);
    }
  });

  describe('backupFirmware', () => {
    it.skipIf(process.platform === 'win32')('publishes private backups even when picotool creates a broadly readable file', async () => {
      const destination = path.join(testDir, 'private.uf2');
      await fs.writeFile(destination, 'old', { mode: 0o600 });
      execa.mockImplementation(async (_, args) => {
        await fs.writeFile(args[2], 'new');
        await fs.chmod(args[2], 0o644);
        return { stdout: 'saved' };
      });
      await backupFirmware(destination, { overwrite: true });
      expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
    });

    it('preflights hard links before extraction and cleans up on unsupported filesystems', async () => {
      const destination = path.join(testDir, 'backup.uf2');
      const unsupported = Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
      vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
        expect(path.dirname(source)).toBe(path.dirname(target));
        expect(path.dirname(source)).not.toBe(testDir);
        // A concurrent creator must remain untouched even when preflight fails.
        await fs.writeFile(destination, 'concurrent backup');
        throw unsupported;
      });
      execa.mockImplementation(async (_, args) => {
        await fs.writeFile(args[2], 'new');
        return { stdout: 'saved' };
      });
      await expect(backupFirmware(destination)).rejects.toThrow(/hard.?link.*choose.*filesystem/i);
      expect(execa).not.toHaveBeenCalled();
      expect(await fs.readFile(destination, 'utf8')).toBe('concurrent backup');
      expect(await fs.readdir(testDir)).toEqual(['backup.uf2']);
    });

    it('cleans staging when publication fails after extraction and a successful hardlink probe', async () => {
      const destination = path.join(testDir, 'backup.uf2');
      const link = fs.link.bind(fs);
      const failure = Object.assign(new Error('publication denied'), { code: 'EACCES' });
      const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (source, target) => {
        if (target === destination) throw failure;
        return link(source, target);
      });
      execa.mockImplementation(async (_, args) => {
        expect(linkSpy).toHaveBeenCalledTimes(1);
        await fs.writeFile(args[2], 'complete firmware');
        return { stdout: 'saved' };
      });
      await expect(backupFirmware(destination)).rejects.toBe(failure);
      expect(execa).toHaveBeenCalledTimes(1);
      expect(linkSpy).toHaveBeenCalledTimes(2);
      expect(await fs.readdir(testDir)).toEqual([]);
    });

    it('rejects aliases into a BOOTSEL ancestor before staging', async () => {
      const bootsel = path.join(testDir, 'bootsel');
      const nested = path.join(bootsel, 'nested');
      const alias = path.join(testDir, 'alias');
      await fs.ensureDir(nested);
      await fs.writeFile(path.join(bootsel, 'INFO_UF2.TXT'), 'Board-ID: RPI-RP2\n');
      await fs.symlink(nested, alias, process.platform === 'win32' ? 'junction' : 'dir');
      execa.mockImplementation(async (_, args) => {
        await fs.writeFile(args[2], 'firmware');
        return { stdout: 'saved' };
      });
      await expect(backupFirmware(path.join(alias, 'backup.uf2'))).rejects.toThrow(/BOOTSEL/);
      expect(execa).not.toHaveBeenCalled();
      expect(await fs.readdir(nested)).toEqual([]);
    });

    it.each([false, true])('rejects overwrite of a destination leaf symlink (dangling: %s)', async (dangling) => {
      const target = path.join(testDir, 'original.uf2');
      const destination = path.join(testDir, 'backup.uf2');
      if (!dangling) await fs.writeFile(target, 'original');
      await fs.symlink(target, destination);
      execa.mockImplementation(async (_, args) => {
        await fs.writeFile(args[2], 'new');
        return { stdout: 'saved' };
      });
      await expect(backupFirmware(destination, { overwrite: true })).rejects.toThrow(/symlink/i);
      expect(execa).not.toHaveBeenCalled();
      expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
      if (!dangling) expect(await fs.readFile(target, 'utf8')).toBe('original');
      expect((await fs.readdir(testDir)).sort()).toEqual(dangling ? ['backup.uf2'] : ['backup.uf2', 'original.uf2']);
    });

    it('rejects a BOOTSEL destination before staging or launching picotool', async () => {
      await fs.writeFile(path.join(testDir, 'INFO_UF2.TXT'), 'Board-ID: RPI-RP2\n');
      execa.mockImplementation(async (_, args) => {
        await fs.writeFile(args[2], 'flash bytes');
        return { stdout: 'saved' };
      });
      await expect(backupFirmware(path.join(testDir, 'backup.uf2'))).rejects.toThrow(/BOOTSEL/);
      expect(execa).not.toHaveBeenCalled();
      expect(await fs.readdir(testDir)).toEqual(['INFO_UF2.TXT']);
    });

    it('does not overwrite a destination created while picotool is running', async () => {
      const destination = path.join(testDir, 'backup.uf2');
      execa.mockImplementation(async (_, args) => {
        await fs.writeFile(destination, 'concurrent backup');
        await fs.writeFile(args[2], 'new');
        return { stdout: 'saved' };
      });
      await expect(backupFirmware(destination)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await fs.readFile(destination, 'utf8')).toBe('concurrent backup');
      expect(await fs.readdir(testDir)).toEqual(['backup.uf2']);
    });

    it('does not replace an existing backup when successful process produces no file', async () => {
      const destination = path.join(testDir, 'backup.uf2');
      await fs.writeFile(destination, 'original');
      execa.mockResolvedValue({ stdout: 'saved' });
      await expect(backupFirmware(destination, { overwrite: true })).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(destination, 'utf8')).toBe('original');
      expect(await fs.readdir(testDir)).toEqual(['backup.uf2']);
    });

    it('refuses existing destinations before spawning unless overwrite is explicit', async () => {
      const destination = path.join(testDir, 'backup.uf2');
      await fs.writeFile(destination, 'original');
      await expect(backupFirmware(destination)).rejects.toThrow(/exist.*overwrite/i);
      expect(execa).not.toHaveBeenCalled();
      execa.mockImplementation(async (command, args, options) => {
        expect(args).toContain('-f');
        expect(options.timeout).toBe(1234);
        expect(await fs.readFile(destination, 'utf8')).toBe('original');
        await fs.writeFile(args[2], 'new');
        return { stdout: 'ok' };
      });
      await backupFirmware(destination, { overwrite: true, force: true, timeout: 1234 });
      expect(await fs.readFile(destination, 'utf8')).toBe('new');
    });

    it('preserves existing backup and cleans partial staging on process failure without retry', async () => {
      const destination = path.join(testDir, 'backup.uf2');
      await fs.writeFile(destination, 'original');
      const failure = Object.assign(new Error('timed out'), { timedOut: true });
      execa.mockImplementation(async (_, args) => {
        await fs.writeFile(args[2], 'partial');
        throw failure;
      });
      await expect(backupFirmware(destination, { overwrite: true })).rejects.toBe(failure);
      expect(await fs.readFile(destination, 'utf8')).toBe('original');
      expect(await fs.readdir(testDir)).toEqual(['backup.uf2']);
      expect(execa).toHaveBeenCalledTimes(1);
    });

    it('rejects drive and invalid timeout before spawn', async () => {
      const destination = path.join(testDir, 'backup.uf2');
      await expect(backupFirmware(destination, { drive: 'E:' })).rejects.toThrow(/drive.*not supported/i);
      await expect(backupFirmware(destination, { timeout: 0 })).rejects.toThrow(/timeout/i);
      expect(execa).not.toHaveBeenCalled();
    });

    it('reports a missing executable clearly and removes staging', async () => {
      execa.mockRejectedValue(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      await expect(backupFirmware(path.join(testDir, 'backup.uf2'))).rejects.toThrow(/picotool is not installed/);
      expect(await fs.readdir(testDir)).toEqual([]);
    });

    it('saves all flash as UF2 in local staging and publishes with explicit selectors', async () => {
      const destination = path.join(testDir, 'backup with spaces.uf2');
      execa.mockImplementation(async (command, args, options) => {
        expect(command).toBe('picotool');
        expect(args).toEqual(['save', '-a', expect.any(String), '-t', 'uf2', '--ser', 'ABC', '--bus', '1', '--address', '2']);
        expect(options).toEqual({ timeout: 60000 });
        expect(args[2]).not.toBe(destination);
        expect(path.dirname(path.dirname(args[2]))).toBe(testDir);
        expect(await fs.pathExists(destination)).toBe(false);
        await fs.writeFile(args[2], 'flash bytes');
        return { stdout: 'Saved\n' };
      });
      expect(await backupFirmware(destination, { serialNumber: 'ABC', bus: 1, address: 2 }))
        .toEqual({ destination, output: 'Saved' });
      expect(await fs.readFile(destination, 'utf8')).toBe('flash bytes');
      expect(await fs.readdir(testDir)).toEqual(['backup with spaces.uf2']);
      expect(execa).toHaveBeenCalledTimes(1);
    });
  });

  describe('putDeviceInFsMode', () => {
    it('calls picotool with reboot -u -f arguments', async () => {
      execa.mockResolvedValue({ stdout: 'Rebooting device' });

      const result = await putDeviceInFsMode();

      expect(execa).toHaveBeenCalledWith('picotool', ['reboot', '-u', '-f'], { timeout: 10000 });
      expect(result).toBe('Rebooting device');
    });

    it('includes serial number when provided', async () => {
      execa.mockResolvedValue({ stdout: 'Rebooting' });

      await putDeviceInFsMode({ serialNumber: 'ABC123' });

      expect(execa).toHaveBeenCalledWith(
        'picotool',
        ['reboot', '-u', '-f', '--ser', 'ABC123'],
        { timeout: 10000 }
      );
    });

    it('includes bus and address when provided', async () => {
      execa.mockResolvedValue({ stdout: 'Rebooting' });

      await putDeviceInFsMode({ bus: 1, address: 2 });

      expect(execa).toHaveBeenCalledWith(
        'picotool',
        ['reboot', '-u', '-f', '--bus', '1', '--address', '2'],
        { timeout: 10000 }
      );
    });

    it('rejects unsupported drive before spawning', async () => {
      for (const drive of ['E:', '', null]) {
        await expect(putDeviceInFsMode({ drive })).rejects.toThrow(/drive.*not supported/i);
      }
      expect(execa).not.toHaveBeenCalled();
    });

    it('uses custom timeout when provided', async () => {
      execa.mockResolvedValue({ stdout: 'Done' });

      await putDeviceInFsMode({ timeout: 5000 });

      expect(execa).toHaveBeenCalledWith('picotool', ['reboot', '-u', '-f'], { timeout: 5000 });
    });

    it('uses custom picotool path when provided', async () => {
      const customPath = path.join(testDir, 'custom-picotool');
      await fs.writeFile(customPath, '');
      execa.mockResolvedValue({ stdout: 'Done' });

      await putDeviceInFsMode({ picotoolPath: customPath });

      expect(execa).toHaveBeenCalledWith(customPath, ['reboot', '-u', '-f'], { timeout: 10000 });
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
    it('accepts a bounded custom timeout', async () => {
      execa.mockResolvedValue({ stdout: 'v1' });
      await getPicotoolVersion(undefined, { timeout: 123 });
      expect(execa).toHaveBeenCalledWith('picotool', ['version'], { timeout: 123 });
    });

    it('rejects invalid timeouts before spawning for version and reboot', async () => {
      for (const timeout of [0, -1, null, '100', 1.5, Infinity, 2147483648]) {
        await expect(getPicotoolVersion(undefined, { timeout })).rejects.toThrow(/timeout/i);
        await expect(putDeviceInFsMode({ timeout })).rejects.toThrow(/timeout/i);
      }
      expect(execa).not.toHaveBeenCalled();
    });
    it('returns picotool version output', async () => {
      execa.mockResolvedValue({ stdout: 'picotool v1.1.2\n' });

      const result = await getPicotoolVersion();

      expect(execa).toHaveBeenCalledWith('picotool', ['version'], { timeout: 10000 });
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
