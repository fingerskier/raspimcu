import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { copyToDevice, copyFromDevice, ensureMountPoint, resolveWithinMount } from '../lib/fileTransfer.js';

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

  it('rejects invalid mount points', async () => {
    await expect(ensureMountPoint(path.join(mountDir, 'missing'))).rejects.toThrow('Mount point not found');
  });

  it('prevents escaping the mount point', () => {
    expect(() => resolveWithinMount(mountDir, '../outside.txt')).toThrow('escapes the mount point');
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

