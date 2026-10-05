import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { isRp2040Device, filterRp2040Devices, listDevices, findMountedBoards, getSingleDevice, waitForMountedBoard } from '../lib/devices.js';

const { serialList } = vi.hoisted(() => ({ serialList: vi.fn(async () => []) }));
vi.mock('serialport', () => ({ SerialPort: { list: serialList } }));
const fixtures = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  serialList.mockReset().mockResolvedValue([]);
  await Promise.all(fixtures.splice(0).map((dir) => fs.remove(dir)));
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'discovery-'));
  fixtures.push(dir);
  return dir;
}
async function board(dir) {
  await fs.ensureDir(dir);
  await fs.writeFile(path.join(dir, 'INFO_UF2.TXT'), 'Board-ID: RPI-RP2\nModel: Raspberry Pi Pico\n');
  return dir;
}

describe('targeted mount wait', () => {
  it.each([
    'Board-ID: RP2350\nModel: Raspberry Pi Pico 2\n',
    'Model: Raspberry Pi Pico\n',
    'NotBoard-ID: RPI-RP2\n',
    'Board-ID: RPI-RP2:unrecognized\n'
  ])('does not report RP2040 readiness for ambiguous metadata %s', async (info) => {
    const mount = await fixture();
    await fs.writeFile(path.join(mount, 'INFO_UF2.TXT'), info);
    await expect(waitForMountedBoard(mount, { timeout: 20, interval: 5 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('validates explicit targets and strict positive timer values before probing', async () => {
    const probe = vi.spyOn(fs, 'lstat');
    for (const target of [undefined, null, '', '   ', 42]) {
      await expect(waitForMountedBoard(target, { timeout: 1 })).rejects.toThrow(/mountPoint/);
    }
    for (const value of [0, -1, 1.5, '5', Infinity, NaN, 2147483648]) {
      await expect(waitForMountedBoard('/target', { timeout: value })).rejects.toThrow(/timeout/i);
      await expect(waitForMountedBoard('/target', { interval: value, timeout: 1 })).rejects.toThrow(/interval/i);
    }
    expect(probe).not.toHaveBeenCalled();
  });
  it('rejects by the deadline even when a filesystem probe stalls', async () => {
    vi.useFakeTimers();
    let release;
    vi.spyOn(fs, 'lstat').mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = waitForMountedBoard('/explicit-target', { timeout: 50, interval: 100 });
    let failure;
    pending.catch((error) => { failure = error; });
    await vi.advanceTimersByTimeAsync(50);
    try {
      expect(failure).toMatchObject({ code: 'ETIMEDOUT' });
      expect(failure.message).toContain('/explicit-target');
    } finally {
      release({ isDirectory: () => false });
      await vi.advanceTimersByTimeAsync(100);
      await pending.catch(() => {});
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not accept a different board or a generic INDEX-only volume', async () => {
    const root = await fixture();
    await board(path.join(root, 'other'));
    const target = path.join(root, 'target');
    await fs.ensureDir(target);
    await fs.writeFile(path.join(target, 'INDEX.HTM'), 'generic volume');
    await expect(waitForMountedBoard(target, { timeout: 30, interval: 5 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await expect(waitForMountedBoard(path.join(root, 'missing'), { timeout: 30, interval: 5 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });
  it('retains storage failure details on wait timeout', async () => {
    vi.spyOn(fs, 'lstat').mockRejectedValue(Object.assign(new Error('I/O unavailable'), { code: 'EIO' }));
    await expect(waitForMountedBoard('/target', { timeout: 20, interval: 5 })).rejects.toMatchObject({
      code: 'ETIMEDOUT', errors: [{ source: 'storage', root: path.resolve('/target'), error: { code: 'EIO' } }]
    });
  });
  it('polls only the explicit target until RP2040 metadata is valid', async () => {
    const root = await fixture();
    const mount = path.join(root, 'target');
    await board(path.join(root, 'other'));
    await fs.ensureDir(mount);
    await fs.writeFile(path.join(mount, 'INFO_UF2.TXT'), 'Board-ID: SAMD21');
    const read = fs.lstat.bind(fs);
    let polls = 0;
    vi.spyOn(fs, 'lstat').mockImplementation(async (file, ...args) => {
      if (file === path.join(mount, 'INFO_UF2.TXT') && ++polls === 3) await board(mount);
      return read(file, ...args);
    });
    const device = await waitForMountedBoard(mount, { timeout: 1000, interval: 5 });
    expect(device.mountPoint).toBe(mount);
    expect(polls).toBe(3);
    expect(serialList).not.toHaveBeenCalled();
    expect(fs.lstat.mock.calls.every(([file]) => file === mount || file === path.join(mount, 'INFO_UF2.TXT'))).toBe(true);
  });
});

describe('mounted discovery', () => {
  it.each(['fifo', 'symlink', 'oversize'])('descends beneath invalid %s metadata while retaining one diagnostic', async (kind) => {
    if (kind === 'fifo' && process.platform === 'win32') return;
    const root = await fixture();
    const info = path.join(root, 'INFO_UF2.TXT');
    const child = await board(path.join(root, 'board'));
    if (kind === 'fifo') execFileSync('mkfifo', [info]);
    else if (kind === 'symlink') await fs.symlink(path.join(child, 'INFO_UF2.TXT'), info);
    else await fs.writeFile(info, 'Board-ID: RPI-RP2\n' + 'x'.repeat(65536));
    await board(path.join(root, 'deep', 'hidden'));
    if (process.platform !== 'win32') await fs.symlink(child, path.join(root, 'alias'), 'dir');
    const errors = [];
    const found = await findMountedBoards([root, root], { maxDepth: 1, errors });
    expect(errors).toEqual([expect.objectContaining({ source: 'storage', root, path: root,
      error: expect.objectContaining({ message: kind === 'symlink'
        ? 'INFO_UF2.TXT must not be a symlink.'
        : 'INFO_UF2.TXT must be a regular file no larger than 64 KiB.' }) })]);
    expect(found.map((device) => device.mountPoint)).toEqual([child]);
  });
  it.each(['INDEX.HTM', 'INFO_UF2.TXT'])('does not prune a valid child beneath an unrelated %s marker', async (marker) => {
    const root = await fixture();
    await fs.writeFile(path.join(root, marker), 'unrelated document');
    const child = await board(path.join(root, 'board'));
    const found = await findMountedBoards([root]);
    expect(found.map((device) => device.mountPoint)).toContain(child);
  });
  it.each(['symlink', 'oversize'])('rejects %s metadata in discovery and readiness', async (kind) => {
    const root = await fixture();
    const mount = path.join(root, 'mount');
    await fs.ensureDir(mount);
    const info = path.join(mount, 'INFO_UF2.TXT');
    if (kind === 'symlink') {
      const target = path.join(root, 'info');
      await fs.writeFile(target, 'Board-ID: RPI-RP2\n');
      await fs.symlink(target, info);
    } else await fs.writeFile(info, 'Board-ID: RPI-RP2\n' + 'x'.repeat(65536));
    const errors = [];
    expect(await findMountedBoards([mount], { errors })).toEqual([]);
    expect(errors).toMatchObject([{ source: 'storage', path: mount }]);
    await expect(waitForMountedBoard(mount, { timeout: 100, interval: 200 })).rejects.toMatchObject({
      code: 'ETIMEDOUT', errors: [{ source: 'storage', path: mount }]
    });
  });
  it('starts storage while serial enumeration is pending and returns stable branch ordering', async () => {
    const mount = await board(await fixture());
    let release;
    serialList.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const reads = vi.spyOn(fs, 'lstat');
    const pending = listDevices({ searchRoots: [mount] });
    try {
      await vi.waitFor(() => expect(reads).toHaveBeenCalledWith(path.join(mount, 'INFO_UF2.TXT')), { timeout: 200 });
    } finally {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      release([{ path: '/dev/z', vendorId: '2e8a' }, { path: '/dev/a', vendorId: '2e8a' }]);
    }
    expect((await pending).devices.map((d) => d.id)).toEqual(['/dev/a', '/dev/z', `storage:${mount}`]);
  });
  it('keeps independent serial and storage failures and exposes no-device causes', async () => {
    const root = await fixture();
    serialList.mockRejectedValue(new Error('serial offline'));
    vi.spyOn(fs, 'lstat').mockRejectedValue(Object.assign(new Error('disk offline'), { code: 'EIO' }));
    const result = await listDevices({ searchRoots: [root] });
    expect(result.errors.map((error) => error.source)).toEqual(['serial', 'storage']);
    expect(result.errors[1]).toMatchObject({ root, error: { code: 'EIO' } });
    const single = await getSingleDevice({ searchRoots: [root] });
    expect(single).toMatchObject({ device: null, count: 0, errors: [
      { source: 'serial', error: { message: result.errors[0].error.message } },
      { source: 'storage', root, error: { code: 'EIO' } }
    ] });
    expect(single.error).toMatch(/serial offline/);
    expect(single.error).toMatch(/disk offline/);
  });
  it('ignores absent roots but reports inaccessible metadata with its root and code', async () => {
    const root = await fixture();
    const mount = await board(path.join(root, 'denied'));
    const original = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(async (file, ...args) => {
      if (file === path.join(mount, 'INFO_UF2.TXT')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return original(file, ...args);
    });
    const errors = [];
    expect(await findMountedBoards([root, path.join(root, 'missing')], { errors })).toEqual([]);
    expect(errors).toEqual([expect.objectContaining({ source: 'storage', root, path: mount,
      error: expect.objectContaining({ code: 'EACCES', message: 'permission denied' }) })]);
  });
  it('validates worker count and depth and supports a root-only scan', async () => {
    const root = await fixture();
    await board(path.join(root, 'child'));
    for (const concurrency of [0, -1, 1.2, '2', Infinity, NaN]) {
      await expect(findMountedBoards([root], { concurrency })).rejects.toThrow(/concurrency/);
    }
    for (const maxDepth of [-1, 1.5, '2', Infinity]) {
      await expect(findMountedBoards([root], { maxDepth })).rejects.toThrow(/maxDepth/);
    }
    expect(await findMountedBoards([root], { maxDepth: 0 })).toEqual([]);
  });
  it.each([undefined, 1, 2, 4])('bounds probes (%s workers), skips symlinks and probes overlapping candidates only once', async (concurrency) => {
    const root = await fixture();
    const mounts = await Promise.all(Array.from({ length: 8 }, (_, i) => board(path.join(root, `b${i}`))));
    await fs.symlink(mounts[0], path.join(root, 'alias'), 'junction');
    let active = 0;
    let peak = 0;
    const calls = [];
    for (const method of ['readFile', 'readdir', 'stat', 'lstat', 'pathExists']) {
      const original = fs[method].bind(fs);
      vi.spyOn(fs, method).mockImplementation(async (...args) => {
        active++;
        peak = Math.max(peak, active);
        calls.push([method, ...args]);
        await new Promise((resolve) => setImmediate(resolve));
        try { return await original(...args); } finally { active--; }
      });
    }
    const devices = await findMountedBoards([root, ...mounts, root, path.join(root, 'alias')], { concurrency });
    expect(devices.map((d) => d.mountPoint)).toEqual(mounts);
    expect(peak).toBeLessThanOrEqual(concurrency ?? 4);
    const infoReads = calls.filter(([method, file]) => method === 'lstat' && file.endsWith('INFO_UF2.TXT'));
    expect(new Set(infoReads.map(([, file]) => file)).size).toBe(infoReads.length);
    expect(calls.filter(([method]) => method === 'stat')).toHaveLength(0);
    expect(calls.filter(([method]) => method === 'readdir').every(([, , options]) => options?.withFileTypes)).toBe(true);
  });
  it('reports readdir I/O failures and skips ENOTDIR roots', async () => {
    const root = await fixture();
    const file = path.join(root, 'not-a-directory');
    await fs.writeFile(file, 'plain file');
    vi.spyOn(fs, 'readdir').mockRejectedValue(Object.assign(new Error('read failed'), { code: 'EIO' }));
    const errors = [];
    expect(await findMountedBoards([root, file, path.join(file, 'child')], { errors })).toEqual([]);
    expect(errors).toMatchObject([{ source: 'storage', root, path: root, error: { code: 'EIO' } }]);
  });
  it('finds Linux user mounts at depth two and stops at a detected board', async () => {
    const root = await fixture();
    const first = await board(path.join(root, 'media', 'user', 'board'));
    const second = await board(path.join(root, 'run', 'media', 'user', 'board'));
    await board(path.join(first, 'nested'));
    await board(path.join(root, 'media', 'user', 'deep', 'hidden'));
    const devices = await findMountedBoards([path.join(root, 'media'), path.join(root, 'run', 'media')]);
    expect(devices.map((d) => d.mountPoint)).toEqual([first, second]);
  });
});

describe('RP2040 device filtering', () => {
  it('recognizes RP2040 serial devices by vendor id', () => {
    const device = {
      type: 'serial',
      vendorId: '2E8A',
      description: 'Serial device'
    };

    expect(isRp2040Device(device)).toBe(true);
  });

  it('rejects serial devices from other vendors', () => {
    const device = {
      type: 'serial',
      vendorId: '1234'
    };

    expect(isRp2040Device(device)).toBe(false);
  });

  it('recognizes RP2040 storage devices via board metadata', () => {
    const device = {
      type: 'storage',
      boardId: 'RPI-RP2',
      model: 'Raspberry Pi Pico'
    };

    expect(isRp2040Device(device)).toBe(true);
  });

  it('filters out non-RP2040 storage devices missing hints', () => {
    const devices = [
      { type: 'storage', boardId: 'SAMD21', model: 'Feather' },
      { type: 'storage', model: 'Generic Flash' }
    ];

    expect(filterRp2040Devices(devices)).toEqual([]);
  });

  it('returns serializable errors when device enumeration fails', async () => {
    const result = await listDevices({ searchRoots: [] });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(() => structuredClone(result)).not.toThrow();
    expect(result.errors[0]).toHaveProperty('source');
    expect(result.errors[0]).toHaveProperty('error.message');
  });
});
