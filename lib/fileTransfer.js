import path from 'path';
import fs from 'fs-extra';

async function ensureMountPoint(mountPoint) {
  if (!mountPoint) {
    throw new Error('A mount point is required.');
  }
  const stats = await fs.stat(mountPoint).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Mount point not found or not a directory: ${mountPoint}`);
  }
  return path.resolve(mountPoint);
}

function resolveWithinMount(mountPoint, targetPath = '.') {
  const absoluteMount = path.resolve(mountPoint);
  const resolvedPath = path.resolve(absoluteMount, targetPath);
  const normalizedMount = process.platform === 'win32' ? absoluteMount.toLowerCase() : absoluteMount;
  const normalizedResolved = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  if (!normalizedResolved.startsWith(normalizedMount)) {
    throw new Error(`Path ${targetPath} escapes the mount point ${mountPoint}`);
  }
  return resolvedPath;
}

function pickTargetPath(targetPath, fallbackName) {
  if (typeof targetPath === 'string' && targetPath.trim().length > 0) {
    return targetPath;
  }
  return fallbackName;
}

async function copyToDevice(source, mountPoint, options = {}) {
  const { targetPath } = options;
  const resolvedMount = await ensureMountPoint(mountPoint);
  const resolvedSource = path.resolve(source);
  const stats = await fs.stat(resolvedSource).catch(() => null);
  if (!stats) {
    throw new Error(`Source path does not exist: ${source}`);
  }

  const fallbackName = stats.isDirectory() ? path.basename(resolvedSource) : path.basename(resolvedSource);
  const destination = resolveWithinMount(resolvedMount, pickTargetPath(targetPath, fallbackName));

  if (stats.isDirectory()) {
    await fs.ensureDir(destination);
    await fs.copy(resolvedSource, destination, { overwrite: true });
  } else {
    await fs.ensureDir(path.dirname(destination));
    await fs.copy(resolvedSource, destination, { overwrite: true });
  }

  return destination;
}

async function copyFromDevice(mountPoint, sourcePath, destination) {
  const resolvedMount = await ensureMountPoint(mountPoint);
  const resolvedSource = resolveWithinMount(resolvedMount, sourcePath);
  const resolvedDestination = path.resolve(destination);
  const stats = await fs.stat(resolvedSource).catch(() => null);
  if (!stats) {
    throw new Error(`Source path on device does not exist: ${sourcePath}`);
  }

  if (stats.isDirectory()) {
    await fs.ensureDir(resolvedDestination);
    await fs.copy(resolvedSource, resolvedDestination, { overwrite: true });
  } else {
    await fs.ensureDir(path.dirname(resolvedDestination));
    await fs.copy(resolvedSource, resolvedDestination, { overwrite: true });
  }

  return resolvedDestination;
}

export { copyToDevice, copyFromDevice, ensureMountPoint, resolveWithinMount };
