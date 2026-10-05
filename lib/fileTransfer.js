import path from 'path';
import fs from 'fs-extra';

// Only ancestors outside the selected local path/device boundary are trusted.
// Resolve host aliases (e.g. macOS /var and /tmp), never the selected leaf.
// Missing destination parents are appended to their nearest canonical ancestor.
// Callers must still check device descendants and copied trees with assertNoSymlinks.
async function canonicalizeLocalPath(target) {
  const absolute = path.resolve(target);
  const parent = path.dirname(absolute);
  if (parent === absolute) return await fs.realpath(absolute);
  const canonicalParent = await fs.realpath(parent).catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    return await canonicalizeLocalPath(parent);
  });
  const canonical = path.join(canonicalParent, path.basename(absolute));
  await assertNoSymlinks(canonical);
  return canonical;
}

async function ensureMountPoint(mountPoint) {
  if (!mountPoint) {
    throw new Error('A mount point is required.');
  }
  const canonicalMount = await canonicalizeLocalPath(mountPoint);
  const stats = await fs.stat(canonicalMount).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Mount point not found or not a directory: ${mountPoint}`);
  }
  return canonicalMount;
}

function resolveWithinMount(mountPoint, targetPath = '.') {
  const absoluteMount = path.resolve(mountPoint);
  const resolvedPath = path.resolve(absoluteMount, targetPath);
  const relative = path.relative(absoluteMount, resolvedPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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

// Reject existing/dangling symlinks; this is not an atomic sandbox against
// concurrent mutation. Copy trees must remain under trusted control.
async function assertNoSymlinks(target, { recursive = false, storageOnly = false } = {}) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stats = await fs.lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stats) return;
    if (stats.isSymbolicLink()) throw new Error(`Symlink paths are not supported: ${current}`);
  }
  if (recursive) {
    const stats = await fs.lstat(absolute);
    if (stats.isDirectory()) {
      const entries = await fs.readdir(absolute);
      if (storageOnly && entries.some((name) => name.toUpperCase() === 'INFO_UF2.TXT')) {
        throw new Error(BOOTSEL_STORAGE_ERROR);
      }
      for (const entry of entries) {
        await assertNoSymlinks(path.join(absolute, entry), { recursive: true, storageOnly });
      }
    } else if (!stats.isFile()) {
      throw new Error(`Only regular files and directories are supported: ${absolute}`);
    }
  }
}

async function safeCopy(source, destination, { storageOnly = false } = {}) {
  await assertNoSymlinks(source, { recursive: true, storageOnly });
  await assertNoSymlinks(destination, { recursive: true, storageOnly });
  if (storageOnly) {
    await rejectBootselStorage(source);
    await rejectBootselStorage(destination);
  }
  await fs.copy(source, destination, {
    overwrite: true,
    filter: async (from, to) => {
      await assertNoSymlinks(from);
      await assertNoSymlinks(to);
      return true;
    },
  });
}

const BOOTSEL_STORAGE_ERROR = 'BOOTSEL is a virtual firmware disk, not regular storage. Use mpremote for MicroPython files or firmware upload for UF2 flashing.';

async function rejectBootselStorage(mountPoint, guidance = 'Use mpremote for MicroPython files or firmware upload for UF2 flashing.') {
  let directory = path.resolve(mountPoint);
  while (true) {
    const entries = await fs.readdir(directory).catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
      throw error;
    });
    if (entries.some((name) => name.toUpperCase() === 'INFO_UF2.TXT')) {
      throw new Error(`BOOTSEL is a virtual firmware disk, not regular storage. ${guidance}`);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

async function copyToDevice(source, mountPoint, options = {}) {
  const { targetPath } = options;
  const resolvedMount = await ensureMountPoint(mountPoint);
  await rejectBootselStorage(resolvedMount);
  const resolvedSource = await canonicalizeLocalPath(source);
  const stats = await fs.stat(resolvedSource).catch(() => null);
  if (!stats) {
    throw new Error(`Source path does not exist: ${source}`);
  }

  const fallbackName = stats.isDirectory() ? path.basename(resolvedSource) : path.basename(resolvedSource);
  const destination = resolveWithinMount(resolvedMount, pickTargetPath(targetPath, fallbackName));

  await safeCopy(resolvedSource, destination, { storageOnly: true });

  return destination;
}

async function copyFromDevice(mountPoint, sourcePath, destination) {
  const resolvedMount = await ensureMountPoint(mountPoint);
  await rejectBootselStorage(resolvedMount);
  const resolvedSource = resolveWithinMount(resolvedMount, sourcePath);
  const resolvedDestination = await canonicalizeLocalPath(destination);
  const stats = await fs.stat(resolvedSource).catch(() => null);
  if (!stats) {
    throw new Error(`Source path on device does not exist: ${sourcePath}`);
  }

  await safeCopy(resolvedSource, resolvedDestination, { storageOnly: true });

  return resolvedDestination;
}

export { canonicalizeLocalPath, copyToDevice, copyFromDevice, ensureMountPoint, resolveWithinMount, assertNoSymlinks, safeCopy, rejectBootselStorage };
