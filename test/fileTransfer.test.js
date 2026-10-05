import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { copyToDevice, copyFromDevice, ensureMountPoint, resolveWithinMount } from '../lib/fileTransfer.js';

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

describe('file transfer helpers', () => {
  let mountDir;
  let workspaceDir;

  beforeEach(async () => {
    mountDir = await createTempDir('mount-');
    workspaceDir = await createTempDir('workspace-');
  });

  afterEach(async () => {
    await cleanupTempDir(mountDir);
    await cleanupTempDir(workspaceDir);
  });

  it('ensures mount point exists', async () => {
    const resolved = await ensureMountPoint(mountDir);
    expect(resolved).toBe(path.resolve(mountDir));
  });

  it('canonicalizes trusted parent aliases without trusting the selected mount or its entries', async () => {
    const parent = path.join(workspaceDir, 'real');
    const alias = path.join(workspaceDir, 'alias');
    await fs.ensureDir(path.join(parent, 'device'));
    await fs.ensureDir(path.join(parent, 'source'));
    await fs.writeFile(path.join(parent, 'source', 'data'), 'payload');
    await fs.symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const mount = path.join(alias, 'device');
    expect(await ensureMountPoint(mount)).toBe(path.join(parent, 'device'));
    const copied = await copyToDevice(path.join(alias, 'source'), mount);
    expect(copied).toBe(path.join(parent, 'device', 'source'));
    expect(await copyFromDevice(mount, 'source', path.join(alias, 'new', 'out')))
      .toBe(path.join(parent, 'new', 'out'));
    expect(await fs.readFile(path.join(parent, 'new', 'out', 'data'), 'utf8')).toBe('payload');
    await fs.symlink(parent, path.join(mount, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(copyToDevice(path.join(alias, 'source'), mount, { targetPath: 'escape/out' })).rejects.toThrow(/symlink/i);
    await expect(copyFromDevice(mount, 'escape/source', path.join(parent, 'out'))).rejects.toThrow(/symlink/i);
    await expect(copyFromDevice(mount, '.', path.join(parent, 'out'))).rejects.toThrow(/symlink/i);
    await fs.symlink(path.join(parent, 'device'), path.join(alias, 'linked-device'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(ensureMountPoint(path.join(alias, 'linked-device'))).rejects.toThrow(/symlink/i);
    await fs.symlink(parent, path.join(parent, 'source', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(copyToDevice(path.join(alias, 'source'), mount)).rejects.toThrow(/symlink/i);
  });

  it('rejects invalid mount points', async () => {
    await expect(ensureMountPoint(path.join(mountDir, 'missing'))).rejects.toThrow('Mount point not found');
  });

  it('prevents escaping the mount point', () => {
    expect(() => resolveWithinMount(mountDir, '../outside.txt')).toThrow('escapes the mount point');
    expect(() => resolveWithinMount(mountDir, `${mountDir}-sibling/file`)).toThrow('escapes the mount point');
  });

  it.each(['parent', 'leaf', 'nested'])('rejects %s symlinks during push and pull', async (kind) => {
    const source = path.join(workspaceDir, 'source');
    await fs.ensureDir(source);
    await fs.writeFile(path.join(source, 'data'), 'new');
    await fs.writeFile(path.join(workspaceDir, 'data'), 'original');
    await fs.ensureDir(path.join(mountDir, 'folder'));
    const link = kind === 'parent' ? 'link' : 'folder/data';
    await fs.symlink(kind === 'parent' ? workspaceDir : path.join(workspaceDir, 'data'), path.join(mountDir, link), kind === 'parent' ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    const targetPath = kind === 'parent' ? 'link/data' : kind === 'leaf' ? 'folder/data' : 'folder';
    await expect(copyToDevice(kind === 'nested' ? source : path.join(source, 'data'), mountDir, { targetPath })).rejects.toThrow(/symlink/i);
    await expect(copyFromDevice(mountDir, kind === 'nested' ? 'folder' : targetPath, path.join(workspaceDir, 'out'))).rejects.toThrow(/symlink/i);
    expect(await fs.readFile(path.join(workspaceDir, 'data'), 'utf8')).toBe('original');
  });

  it('rejects source-tree symlinks rather than installing escapes on storage', async () => {
    const source = path.join(workspaceDir, 'source');
    await fs.ensureDir(source);
    await fs.symlink(workspaceDir, path.join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(copyToDevice(source, mountDir)).rejects.toThrow(/symlink/i);
    expect(await fs.pathExists(path.join(mountDir, 'source'))).toBe(false);
  });

  it('rejects generic push and pull on the BOOTSEL virtual disk', async () => {
    await fs.writeFile(path.join(mountDir, 'INFO_UF2.TXT'), 'UF2 Bootloader\nBoard-ID: RPI-RP2\n');
    const source = path.join(workspaceDir, 'main.py');
    await fs.writeFile(source, 'print(1)');
    await expect(copyToDevice(source, mountDir)).rejects.toThrow(/BOOTSEL.*mpremote.*firmware/i);
    await expect(copyFromDevice(mountDir, 'INFO_UF2.TXT', path.join(workspaceDir, 'out'))).rejects.toThrow(/BOOTSEL.*mpremote.*firmware/i);
    expect(await fs.pathExists(path.join(mountDir, 'main.py'))).toBe(false);
  });

  it('rejects BOOTSEL disks selected beneath a regular storage root', async () => {
    const bootsel = path.join(mountDir, 'boot');
    await fs.ensureDir(bootsel);
    await fs.writeFile(path.join(bootsel, 'INFO_UF2.TXT'), 'Board-ID: RPI-RP2');
    const source = path.join(workspaceDir, 'main.py');
    await fs.writeFile(source, 'print(1)');
    await expect(copyToDevice(source, mountDir, { targetPath: 'boot/new/main.py' })).rejects.toThrow(/BOOTSEL/);
    await expect(copyFromDevice(mountDir, 'boot', path.join(workspaceDir, 'out'))).rejects.toThrow(/BOOTSEL/);
    await expect(copyFromDevice(mountDir, '.', path.join(workspaceDir, 'out'))).rejects.toThrow(/BOOTSEL/);
    expect(await fs.pathExists(path.join(bootsel, 'new'))).toBe(false);
    expect(await fs.pathExists(path.join(workspaceDir, 'out'))).toBe(false);
  });

  it('copies a file to the device', async () => {
    const sourceFile = path.join(workspaceDir, 'main.py');
    await fs.writeFile(sourceFile, 'print("hello")');

    const destination = await copyToDevice(sourceFile, mountDir);

    expect(destination).toBe(path.join(mountDir, 'main.py'));
    expect(await fs.pathExists(destination)).toBe(true);
    expect(await fs.readFile(destination, 'utf8')).toBe('print("hello")');
  });

  it('copies a directory from the device', async () => {
    const deviceDir = path.join(mountDir, 'lib');
    await fs.ensureDir(deviceDir);
    await fs.writeFile(path.join(deviceDir, 'module.py'), '# module');

    const destinationDir = path.join(workspaceDir, 'downloaded');
    const resolvedDestination = await copyFromDevice(mountDir, 'lib', destinationDir);

    expect(resolvedDestination).toBe(path.resolve(destinationDir));
    expect(await fs.pathExists(path.join(destinationDir, 'module.py'))).toBe(true);
  });
});

