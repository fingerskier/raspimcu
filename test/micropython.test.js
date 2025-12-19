import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

vi.mock('execa', () => ({
  execa: vi.fn()
}));

import { execa } from 'execa';
import {
  uploadToMicropython,
  downloadFromMicropython,
  runMicropythonRepl
} from '../lib/micropython.js';

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

describe('micropython wrapper', () => {
  let tempDir;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await createTempDir('mp-');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('uploadToMicropython', () => {
    it('calls mpremote with correct arguments for file upload', async () => {
      const sourceFile = path.join(tempDir, 'main.py');
      await fs.writeFile(sourceFile, 'print("hello")');
      execa.mockResolvedValue({ stdout: '' });

      const result = await uploadToMicropython('/dev/ttyACM0', sourceFile, '/main.py');

      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        ['connect', '/dev/ttyACM0', 'fs', 'cp', sourceFile, ':/main.py'],
        { timeout: undefined }
      );
      expect(result.source).toBe(sourceFile);
      expect(result.target).toBe(':/main.py');
    });

    it('adds -r flag for directory upload', async () => {
      const sourceDir = path.join(tempDir, 'lib');
      await fs.ensureDir(sourceDir);
      await fs.writeFile(path.join(sourceDir, 'module.py'), '');
      execa.mockResolvedValue({ stdout: '' });

      await uploadToMicropython('/dev/ttyACM0', sourceDir, '/lib');

      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        ['connect', '/dev/ttyACM0', 'fs', 'cp', '-r', sourceDir, ':/lib'],
        { timeout: undefined }
      );
    });

    it('prepends colon to remote path if missing', async () => {
      const sourceFile = path.join(tempDir, 'test.py');
      await fs.writeFile(sourceFile, '');
      execa.mockResolvedValue({ stdout: '' });

      await uploadToMicropython('/dev/ttyACM0', sourceFile, 'boot.py');

      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        expect.arrayContaining([':boot.py']),
        expect.any(Object)
      );
    });

    it('throws when source does not exist', async () => {
      await expect(
        uploadToMicropython('/dev/ttyACM0', '/nonexistent/file.py', '/main.py')
      ).rejects.toThrow('Source path does not exist');
    });

    it('uses custom mpremote path', async () => {
      const sourceFile = path.join(tempDir, 'main.py');
      await fs.writeFile(sourceFile, '');
      execa.mockResolvedValue({ stdout: '' });

      await uploadToMicropython('/dev/ttyACM0', sourceFile, '/main.py', {
        mpremotePath: '/custom/mpremote'
      });

      expect(execa).toHaveBeenCalledWith(
        '/custom/mpremote',
        expect.any(Array),
        expect.any(Object)
      );
    });

    it('passes timeout to execa', async () => {
      const sourceFile = path.join(tempDir, 'main.py');
      await fs.writeFile(sourceFile, '');
      execa.mockResolvedValue({ stdout: '' });

      await uploadToMicropython('/dev/ttyACM0', sourceFile, '/main.py', {
        timeout: 30000
      });

      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        expect.any(Array),
        { timeout: 30000 }
      );
    });

    it('throws friendly error when mpremote not installed', async () => {
      const sourceFile = path.join(tempDir, 'main.py');
      await fs.writeFile(sourceFile, '');
      const error = new Error('spawn mpremote ENOENT');
      error.code = 'ENOENT';
      execa.mockRejectedValue(error);

      await expect(
        uploadToMicropython('/dev/ttyACM0', sourceFile, '/main.py')
      ).rejects.toThrow('mpremote is not installed or not available on the PATH');
    });

    it('throws when serial path is missing', async () => {
      const sourceFile = path.join(tempDir, 'test.py');
      await fs.writeFile(sourceFile, '');

      await expect(
        uploadToMicropython(null, sourceFile, '/main.py')
      ).rejects.toThrow('A serial port path is required');
    });
  });

  describe('downloadFromMicropython', () => {
    it('calls mpremote with correct arguments', async () => {
      const destFile = path.join(tempDir, 'downloaded.py');
      execa.mockResolvedValue({ stdout: '' });

      const result = await downloadFromMicropython('/dev/ttyACM0', '/main.py', destFile);

      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        ['connect', '/dev/ttyACM0', 'fs', 'cp', ':/main.py', destFile],
        { timeout: undefined }
      );
      expect(result.source).toBe(':/main.py');
      expect(result.destination).toBe(destFile);
    });

    it('adds -r flag when recursive option is set', async () => {
      const destDir = path.join(tempDir, 'downloaded');
      execa.mockResolvedValue({ stdout: '' });

      await downloadFromMicropython('/dev/ttyACM0', '/lib', destDir, {
        recursive: true
      });

      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        ['connect', '/dev/ttyACM0', 'fs', 'cp', '-r', ':/lib', destDir],
        { timeout: undefined }
      );
    });

    it('appends filename when destination is a directory', async () => {
      const destDir = path.join(tempDir, 'downloads');
      await fs.ensureDir(destDir);
      execa.mockResolvedValue({ stdout: '' });

      const result = await downloadFromMicropython('/dev/ttyACM0', '/main.py', destDir);

      const expectedDest = path.join(destDir, 'main.py');
      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        expect.arrayContaining([expectedDest]),
        expect.any(Object)
      );
      expect(result.destination).toBe(expectedDest);
    });

    it('passes timeout to execa', async () => {
      const destFile = path.join(tempDir, 'out.py');
      execa.mockResolvedValue({ stdout: '' });

      await downloadFromMicropython('/dev/ttyACM0', '/main.py', destFile, {
        timeout: 15000
      });

      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        expect.any(Array),
        { timeout: 15000 }
      );
    });
  });

  describe('runMicropythonRepl', () => {
    it('executes code with exec command', async () => {
      execa.mockResolvedValue({ stdout: 'Hello World\n' });

      const result = await runMicropythonRepl('/dev/ttyACM0', {
        code: 'print("Hello World")'
      });

      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        ['connect', '/dev/ttyACM0', 'exec', 'print("Hello World")'],
        { timeout: undefined }
      );
      expect(result).toBe('Hello World');
    });

    it('opens interactive repl with stdio inherit when no code provided', async () => {
      execa.mockResolvedValue({ stdout: '' });

      await runMicropythonRepl('/dev/ttyACM0');

      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        ['connect', '/dev/ttyACM0', 'repl'],
        { stdio: 'inherit', timeout: undefined }
      );
    });

    it('uses custom mpremote path', async () => {
      execa.mockResolvedValue({ stdout: 'result' });

      await runMicropythonRepl('/dev/ttyACM0', {
        mpremotePath: '/custom/mpremote',
        code: '1+1'
      });

      expect(execa).toHaveBeenCalledWith(
        '/custom/mpremote',
        expect.any(Array),
        expect.any(Object)
      );
    });

    it('passes timeout to execa', async () => {
      execa.mockResolvedValue({ stdout: '' });

      await runMicropythonRepl('/dev/ttyACM0', {
        code: 'test',
        timeout: 5000
      });

      expect(execa).toHaveBeenCalledWith(
        'mpremote',
        expect.any(Array),
        { timeout: 5000 }
      );
    });

    it('throws friendly error when mpremote not installed', async () => {
      const error = new Error('spawn mpremote ENOENT');
      error.code = 'ENOENT';
      execa.mockRejectedValue(error);

      await expect(
        runMicropythonRepl('/dev/ttyACM0', { code: 'test' })
      ).rejects.toThrow('mpremote is not installed or not available on the PATH');
    });
  });
});
