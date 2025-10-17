import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';

function ensureSerialPath(serialPath) {
  if (!serialPath || typeof serialPath !== 'string') {
    throw new Error('A serial port path is required to communicate with a MicroPython device.');
  }
  return serialPath;
}

function formatRemotePath(remotePath) {
  if (!remotePath || typeof remotePath !== 'string') {
    throw new Error('A remote path on the MicroPython device is required.');
  }
  return remotePath.startsWith(':') ? remotePath : `:${remotePath}`;
}

async function runMpremote(args, options = {}) {
  const command = options.mpremotePath || 'mpremote';
  const timeout = options.timeout;

  try {
    if (options.stdio === 'inherit') {
      await execa(command, args, { stdio: 'inherit', timeout });
      return '';
    }

    const { stdout } = await execa(command, args, { timeout });
    return stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('mpremote is not installed or not available on the PATH.');
    }
    throw error;
  }
}

function buildConnectionArgs(serialPath) {
  return ['connect', ensureSerialPath(serialPath)];
}

async function uploadToMicropython(serialPath, source, target, options = {}) {
  const resolvedSource = path.resolve(source);
  const stats = await fs.stat(resolvedSource).catch(() => null);
  if (!stats) {
    throw new Error(`Source path does not exist: ${source}`);
  }

  const remoteTarget = formatRemotePath(target);
  const args = [...buildConnectionArgs(serialPath), 'fs', 'cp'];
  if (stats.isDirectory()) {
    args.push('-r');
  }
  args.push(resolvedSource, remoteTarget);

  await runMpremote(args, options);
  return { source: resolvedSource, target: remoteTarget };
}

async function downloadFromMicropython(serialPath, remotePath, destination, options = {}) {
  const remoteSource = formatRemotePath(remotePath);
  const resolvedDestination = path.resolve(destination);
  const remoteBasename = path.basename(remoteSource.startsWith(':') ? remoteSource.slice(1) : remoteSource);
  let finalDestination = resolvedDestination;

  const destinationStats = await fs.stat(resolvedDestination).catch(() => null);
  if (destinationStats && destinationStats.isDirectory()) {
    finalDestination = path.join(resolvedDestination, remoteBasename);
  } else {
    await fs.ensureDir(path.dirname(resolvedDestination));
  }

  await fs.ensureDir(path.dirname(finalDestination));

  const args = [...buildConnectionArgs(serialPath), 'fs', 'cp'];
  if (options.recursive) {
    args.push('-r');
  }
  args.push(remoteSource, finalDestination);

  await runMpremote(args, options);
  return { source: remoteSource, destination: finalDestination };
}

async function runMicropythonRepl(serialPath, options = {}) {
  const baseArgs = buildConnectionArgs(serialPath);
  if (options.code) {
    const output = await runMpremote([...baseArgs, 'exec', options.code], options);
    return output;
  }

  await runMpremote([...baseArgs, 'repl'], { ...options, stdio: 'inherit' });
  return '';
}

export { uploadToMicropython, downloadFromMicropython, runMicropythonRepl };
