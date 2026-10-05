import fs from 'fs-extra';
import { normalizeTimeout } from './timeout.js';
import { loadSerialPort } from './serialPort.js';
import { putDeviceInFsMode } from './picotool.js';

const BOOTSEL_METHODS = Object.freeze(['repl', 'touch1200', 'picotool']);

const DETACH_WINDOW = 3000;
const DETACH_POLL_INTERVAL = 250;
const PROMPT_WAIT = 500;
const CLOSE_WAIT = 1000;
const MAX_CAPTURE = 4096;

const INTERRUPT = Buffer.from([0x03, 0x03]);
// Ctrl-B first: it leaves raw REPL (where a line would wait for Ctrl-D) if a
// previous tool such as mpremote left the board there; otherwise it only prints the banner.
const BOOTLOADER_COMMAND = Buffer.from('\x02\r\nimport machine; machine.bootloader()\r\n', 'latin1');

function remaining(deadline) {
  return Math.max(0, deadline - Date.now());
}

function withDeadline(promise, deadline, label) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`Timed out ${label}.`), { code: 'ETIMEDOUT' }));
    }, remaining(deadline));
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function step(start, deadline, label) {
  return withDeadline(new Promise((resolve, reject) => {
    start((error) => (error ? reject(error) : resolve()));
  }), deadline, label);
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toUpperCase() === b.toUpperCase() : a === b;
}

async function isListed(SerialPort, serialPath) {
  const ports = await SerialPort.list();
  return ports.some((port) => typeof port.path === 'string' && samePath(port.path, serialPath));
}

/**
 * Pick a presence check proven against the current state, so an alias the
 * enumerator never reports (e.g. /dev/serial/by-id/...) cannot read as "detached".
 */
async function presenceProbe(SerialPort, serialPath, deadline) {
  if (process.platform !== 'win32' && await fs.pathExists(serialPath)) {
    return () => fs.pathExists(serialPath);
  }
  if (typeof SerialPort.list !== 'function') return null;
  try {
    if (await withDeadline(isListed(SerialPort, serialPath), deadline, `listing serial ports`)) {
      return () => isListed(SerialPort, serialPath);
    }
  } catch {
    // Without a baseline there is nothing trustworthy to poll.
  }
  return null;
}

function trackPort(port) {
  const session = { output: '', closed: false };
  session.whenClosed = new Promise((resolve) => {
    port.once('close', () => {
      session.closed = true;
      resolve();
    });
  });
  // Errors also surface through callbacks; a late one must never crash the host.
  port.on('error', () => {});
  // A pending read is what lets serialport notice a USB detach and emit close.
  port.on('data', (chunk) => {
    if (session.output.length < MAX_CAPTURE) {
      session.output += Buffer.from(chunk).toString('latin1');
    }
  });
  return session;
}

async function releasePort(port, session) {
  if (port.opening) {
    // An open that outlived its deadline is closed as soon as it lands.
    port.once('open', () => port.close(() => {}));
    return;
  }
  if (port.isOpen) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, CLOSE_WAIT);
      port.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  } else if (port.closing) {
    let timer;
    await Promise.race([session.whenClosed, new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_WAIT); })]);
    clearTimeout(timer);
  }
}

function waitForPrompt(port, session, ms) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      port.off('data', check);
      resolve();
    };
    const check = () => {
      if (session.closed || />>> $|\n>$/.test(session.output)) finish();
    };
    const timer = setTimeout(finish, ms);
    port.on('data', check);
    check();
  });
}

/** Resolves true once the port closes unsolicited (session) or the probe stops seeing it. */
function waitForDetach(session, probe, ms) {
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer;
    const finish = (detached) => {
      if (settled) return;
      settled = true;
      clearTimeout(windowTimer);
      clearTimeout(pollTimer);
      resolve(detached);
    };
    const windowTimer = setTimeout(() => finish(false), ms);
    if (session) {
      if (session.closed) finish(true);
      session.whenClosed.then(() => finish(true));
    }
    const poll = async () => {
      let present = true;
      try {
        present = await probe();
      } catch {
        // Enumeration can fail transiently while the bus re-enumerates.
      }
      if (settled) return;
      if (!present) finish(true);
      else pollTimer = setTimeout(poll, DETACH_POLL_INTERVAL);
    };
    if (probe && !settled) void poll();
  });
}

async function requireSerialPort() {
  const SerialPort = await loadSerialPort();
  if (!SerialPort) {
    throw new Error('serialport package is not available. Install it to enable serial BOOTSEL methods.');
  }
  return SerialPort;
}

async function attemptRepl({ path: serialPath }, deadline) {
  const SerialPort = await requireSerialPort();
  const probe = await presenceProbe(SerialPort, serialPath, deadline);
  const port = new SerialPort({ path: serialPath, baudRate: 115200, autoOpen: false });
  const session = trackPort(port);
  try {
    await step((done) => port.open(done), deadline, `opening ${serialPath}`);
    await step((done) => port.write(INTERRUPT, done), deadline, `interrupting ${serialPath}`);
    await waitForPrompt(port, session, Math.min(PROMPT_WAIT, remaining(deadline)));
    if (session.closed) {
      throw new Error(`${serialPath} closed before machine.bootloader() was sent.`);
    }
    let writeError;
    try {
      await step((done) => port.write(BOOTLOADER_COMMAND, done), deadline, `writing to ${serialPath}`);
    } catch (error) {
      // The board may detach mid-write; the detach window decides.
      writeError = error;
    }
    const window = Math.min(DETACH_WINDOW, remaining(deadline));
    if (!(await waitForDetach(session, probe, window))) {
      throw writeError ?? new Error(`${serialPath} did not disconnect within ${window} ms of machine.bootloader(); the MicroPython REPL may not be reachable on this port.`);
    }
    return session.output.trim();
  } finally {
    await releasePort(port, session);
  }
}

async function attemptTouch1200({ path: serialPath }, deadline) {
  const SerialPort = await requireSerialPort();
  const probe = await presenceProbe(SerialPort, serialPath, deadline);
  if (!probe) {
    throw new Error(`Cannot observe whether ${serialPath} detaches, so a 1200-baud touch would be unverifiable.`);
  }
  const port = new SerialPort({ path: serialPath, baudRate: 1200, autoOpen: false });
  const session = trackPort(port);
  let detachedEarly = false;
  try {
    await step((done) => port.open(done), deadline, `opening ${serialPath} at 1200 baud`);
    await step((done) => port.set({ dtr: false, rts: false }, done), deadline, `dropping DTR/RTS on ${serialPath}`);
    detachedEarly = session.closed;
  } finally {
    // Closing at 1200 baud with DTR low is the touch itself.
    await releasePort(port, session);
  }
  if (detachedEarly) return '';
  const window = Math.min(DETACH_WINDOW, remaining(deadline));
  if (!(await waitForDetach(null, probe, window))) {
    throw new Error(`${serialPath} did not detach within ${window} ms of a 1200-baud touch; the firmware may not support it.`);
  }
  return '';
}

async function attemptPicotool(options, deadline) {
  const { serialNumber, bus, address, picotoolPath } = options;
  return putDeviceInFsMode({ serialNumber, bus, address, picotoolPath, timeout: Math.max(1, remaining(deadline)) });
}

const ATTEMPTS = { repl: attemptRepl, touch1200: attemptTouch1200, picotool: attemptPicotool };

function normalizeMethods(methods) {
  if (methods === undefined) return [...BOOTSEL_METHODS];
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new TypeError(`methods must be a non-empty array drawn from: ${BOOTSEL_METHODS.join(', ')}.`);
  }
  for (const method of methods) {
    if (!BOOTSEL_METHODS.includes(method)) {
      throw new TypeError(`Unknown BOOTSEL method: ${String(method)}. Expected one of: ${BOOTSEL_METHODS.join(', ')}.`);
    }
  }
  if (new Set(methods).size !== methods.length) {
    throw new TypeError('methods must not list a method more than once.');
  }
  return [...methods];
}

/**
 * Reboot an RP2040 into BOOTSEL, trying each method in order until one works.
 *
 * - `repl`: interrupt the program over `path` and run `machine.bootloader()`.
 * - `touch1200`: open `path` at 1200 baud and drop DTR/RTS (Arduino-pico style;
 *   stock MicroPython rp2 builds ignore it).
 * - `picotool`: `putDeviceInFsMode` with the same selectors.
 *
 * Serial methods are skipped without `path` and never filter by USB vendor ID.
 * Success means the serial device detached (or picotool returned); pair with
 * `waitForMountedBoard` to verify the BOOTSEL volume.
 *
 * @param {object} options
 * @param {string} [options.path] Serial port of the running board.
 * @param {string} [options.serialNumber] picotool `--ser` selector.
 * @param {number|string} [options.bus] picotool `--bus` selector.
 * @param {number|string} [options.address] picotool `--address` selector.
 * @param {string} [options.picotoolPath] Custom picotool executable.
 * @param {number} [options.timeout=10000] Total budget in ms, shared by all attempts.
 * @param {Array<'repl'|'touch1200'|'picotool'>} [options.methods] Order to try;
 *   default `['repl', 'touch1200', 'picotool']`.
 * @returns {Promise<{ method: string, output: string }>}
 * @throws {TypeError} On invalid options or when no requested method can run.
 * @throws {Error} When every attempt fails; `errors` holds `{ method, message }`
 *   per attempt and `code` is `ETIMEDOUT` if the budget ran out first.
 */
async function rebootToBootsel(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object.');
  }
  const { path: serialPath, serialNumber } = options;
  if (serialPath !== undefined && (typeof serialPath !== 'string' || !serialPath.trim())) {
    throw new TypeError('path must be a non-empty serial port path.');
  }
  if (serialNumber !== undefined && (typeof serialNumber !== 'string' || !serialNumber)) {
    throw new TypeError('serialNumber must be a non-empty string.');
  }
  if (options.drive !== undefined) {
    throw new TypeError('picotool drive targeting is not supported; use serialNumber, bus or address.');
  }
  const methods = normalizeMethods(options.methods);
  const timeout = normalizeTimeout(options.timeout, 10000);
  const plan = methods.filter((method) => method === 'picotool' || serialPath !== undefined);
  if (plan.length === 0) {
    throw new TypeError(`A serial path is required for the requested BOOTSEL methods: ${methods.join(', ')}.`);
  }

  const deadline = Date.now() + timeout;
  const errors = [];
  for (const method of plan) {
    if (remaining(deadline) <= 0) break;
    try {
      const output = await ATTEMPTS[method](options, deadline);
      return { method, output };
    } catch (error) {
      errors.push({ method, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const untried = plan.slice(errors.length);
  const details = errors.map((entry) => `${entry.method}: ${entry.message.replace(/\.$/, '')}`);
  if (untried.length) details.push(`timeout of ${timeout} ms exhausted before ${untried.join(', ')}`);
  const error = new Error(`Unable to reboot into BOOTSEL. ${details.join('; ')}`);
  error.errors = errors;
  if (untried.length) error.code = 'ETIMEDOUT';
  throw error;
}

export { rebootToBootsel, BOOTSEL_METHODS };
