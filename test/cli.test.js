import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/index.js', () => ({
  listDevices: vi.fn(),
  getSingleDevice: vi.fn(),
  putDeviceInFsMode: vi.fn(),
  rebootToBootsel: vi.fn(),
  BOOTSEL_METHODS: ['repl', 'touch1200', 'picotool'],
  waitForMountedBoard: vi.fn(),
  copyToDevice: vi.fn(),
  copyFromDevice: vi.fn(),
  uploadFirmware: vi.fn(),
  downloadFirmware: vi.fn(),
  backupFirmware: vi.fn(),
  readInfoFile: vi.fn(),
  uploadToMicropython: vi.fn(),
  downloadFromMicropython: vi.fn(),
  runMicropythonRepl: vi.fn()
}));

import { runCli } from '../lib/cli.js';
import * as api from '../lib/index.js';

function run(...args) {
  return runCli(['node', 'raspimcu', ...args]);
}

describe('CLI contracts', () => {
  let previousExitCode;

  beforeEach(() => {
    vi.resetAllMocks();
    previousExitCode = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  it('does not issue an untargeted reboot when the selected serial device has no serial number', async () => {
    api.getSingleDevice.mockResolvedValue({ device: { path: '/dev/fake' }, error: null });
    await run('put-fs');
    expect(api.putDeviceInFsMode).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error.mock.calls.flat().join(' ')).toMatch(/explicit.*serial|bus.*address/i);
  });

  it.each(['repl', 'touch1200', 'repl,touch1200'])('auto-selects a path without a USB serial for %s', async (methods) => {
    api.getSingleDevice.mockResolvedValue({ device: { path: '/dev/fake' }, error: null });
    api.rebootToBootsel.mockResolvedValue({ method: methods.split(',')[0], output: '' });
    await run('put-fs', '--methods', methods);
    expect(api.rebootToBootsel).toHaveBeenCalledWith(expect.objectContaining({
      path: '/dev/fake', serialNumber: undefined, methods: methods.split(',')
    }));
    expect(api.putDeviceInFsMode).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it.each(['picotool', 'repl,picotool', 'touch1200,picotool'])('keeps auto-selection targeted when %s can invoke picotool', async (methods) => {
    api.getSingleDevice.mockResolvedValue({ device: { path: '/dev/fake' }, error: null });
    await run('put-fs', '--methods', methods);
    expect(api.rebootToBootsel).not.toHaveBeenCalled();
    expect(api.putDeviceInFsMode).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects serial-only auto-selection without a usable path', async () => {
    api.getSingleDevice.mockResolvedValue({ device: { serialNumber: 'ABC' }, error: null });
    await run('put-fs', '--methods', 'repl');
    expect(api.rebootToBootsel).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects the unsupported drive selector before device access', async () => {
    await run('put-fs', '--drive', 'E:');
    expect(api.putDeviceInFsMode).not.toHaveBeenCalled();
    expect(api.getSingleDevice).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error.mock.calls.flat().join(' ')).toMatch(/drive.*not supported/i);
  });

  it('reports mount readiness only after an explicit target is verified', async () => {
    api.putDeviceInFsMode.mockResolvedValue('Rebooting');
    api.waitForMountedBoard.mockResolvedValue({ mountPoint: '/media/user/RPI-RP2' });
    await run('put-fs', '--serial', 'ABC', '--wait-mount', '/media/user/RPI-RP2', '--wait-timeout', '800');
    expect(api.putDeviceInFsMode).toHaveBeenCalledWith(expect.objectContaining({ serialNumber: 'ABC' }));
    expect(api.waitForMountedBoard).toHaveBeenCalledWith('/media/user/RPI-RP2', { timeout: 800 });
    expect(api.putDeviceInFsMode.mock.invocationCallOrder[0]).toBeLessThan(api.waitForMountedBoard.mock.invocationCallOrder[0]);
    expect(console.log).toHaveBeenCalledWith('BOOTSEL mount verified at /media/user/RPI-RP2');
  });

  it('fails rather than reporting readiness when the mount never appears', async () => {
    api.putDeviceInFsMode.mockResolvedValue('');
    api.waitForMountedBoard.mockRejectedValue(new Error('Timed out waiting for BOOTSEL mount'));
    await run('put-fs', '--serial', 'ABC', '--wait-mount', '/missing');
    expect(process.exitCode).toBe(1);
    expect(console.log.mock.calls.flat().join(' ')).not.toContain('mount verified');
  });

  it('reboots over an explicit serial port without auto-selection or the picotool-only path', async () => {
    api.rebootToBootsel.mockResolvedValue({ method: 'repl', output: '>>>' });
    await run('put-fs', '--port', '/dev/ttyACM0', '--serial', 'ABC', '--methods', 'repl, picotool', '--timeout', '7000');
    expect(api.getSingleDevice).not.toHaveBeenCalled();
    expect(api.putDeviceInFsMode).not.toHaveBeenCalled();
    expect(api.rebootToBootsel).toHaveBeenCalledWith({
      path: '/dev/ttyACM0', serialNumber: 'ABC', bus: undefined, address: undefined,
      picotoolPath: undefined, timeout: 7000, methods: ['repl', 'picotool']
    });
    expect(process.exitCode).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('mount readiness not verified'));
  });

  it('reports every failed BOOTSEL method with a nonzero exit', async () => {
    api.rebootToBootsel.mockRejectedValue(new Error('Unable to reboot into BOOTSEL. repl: no disconnect; picotool: not installed'));
    await run('put-fs', '--port', '/dev/ttyACM0');
    expect(api.rebootToBootsel).toHaveBeenCalledWith(expect.objectContaining({ path: '/dev/ttyACM0', methods: undefined }));
    expect(process.exitCode).toBe(1);
    expect(console.error.mock.calls.flat().join(' ')).toMatch(/repl: no disconnect; picotool: not installed/);
  });

  it.each(['bogus', 'repl,repl', ','])('rejects invalid --methods %s before device access', async (methods) => {
    await expect(run('put-fs', '--port', '/dev/ttyACM0', '--methods', methods)).rejects.toThrow();
    expect(api.rebootToBootsel).not.toHaveBeenCalled();
    expect(process.stderr.write.mock.calls.flat().join('')).toMatch(/methods/i);
  });

  it('reports UF2 copy completion without claiming a verified flash', async () => {
    api.uploadFirmware.mockResolvedValue('/volume/fw.uf2');
    await run('firmware', 'upload', 'fw.uf2', '/volume');
    expect(console.log).toHaveBeenCalledWith('UF2 copied to /volume/fw.uf2; device flash/boot not verified.');
  });

  it('backs up flash with explicit targeting and overwrite consent', async () => {
    api.backupFirmware.mockResolvedValue({ destination: '/backup.uf2', output: 'Saved' });
    await run('firmware', 'backup', '/backup.uf2', '--serial', 'ABC', '--picotool', '/fake-tool', '--timeout', '9000', '--overwrite');
    expect(api.backupFirmware).toHaveBeenCalledWith('/backup.uf2', {
      serialNumber: 'ABC', bus: undefined, address: undefined,
      picotoolPath: '/fake-tool', timeout: 9000, overwrite: true, force: false
    });
    expect(console.log).toHaveBeenCalledWith('Flash backup saved to /backup.uf2');
  });

  it.each(['12oops', '0', '-1', '1.5', '2147483648'])('rejects invalid timeout %s before executing anything', async (timeout) => {
    await expect(run('micropython', 'repl', '/dev/fake', '--exec', 'pass', '--timeout', timeout)).rejects.toThrow();
    expect(api.runMicropythonRepl).not.toHaveBeenCalled();
    expect(process.stderr.write.mock.calls.flat().join('')).toMatch(/timeout/i);
  });
});
