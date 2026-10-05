import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';

const state = vi.hoisted(() => ({ ports: [], behavior: {}, listed: () => [] }));

vi.mock('execa', () => ({
  execa: vi.fn()
}));

vi.mock('serialport', async () => {
  const { EventEmitter } = await import('node:events');
  const later = (fn) => Promise.resolve().then(fn);

  class FakeSerialPort extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.isOpen = false;
      this.opening = false;
      this.closing = false;
      this.written = [];
      this.setCalls = [];
      this.closeCalls = 0;
      state.ports.push(this);
    }

    open(callback) {
      this.opening = true;
      const finish = (error) => {
        this.opening = false;
        if (!error) {
          this.isOpen = true;
          this.emit('open');
        }
        callback(error ?? null);
      };
      if (state.behavior.open) state.behavior.open(this, finish);
      else later(() => finish());
    }

    write(data, callback) {
      this.written.push(Buffer.from(data));
      if (state.behavior.write) state.behavior.write(this, Buffer.from(data), callback);
      else later(() => callback(null));
      return true;
    }

    set(flags, callback) {
      this.setCalls.push(flags);
      later(() => callback(null));
    }

    close(callback) {
      this.closeCalls += 1;
      if (!this.isOpen) {
        later(() => callback?.(new Error('Port is not open')));
        return;
      }
      this.isOpen = false;
      later(() => {
        this.emit('close', null);
        callback?.(null);
      });
    }

    // Simulate the device re-enumerating out from under an open handle.
    disconnect() {
      if (!this.isOpen) return;
      this.isOpen = false;
      this.emit('close', Object.assign(new Error('disconnected'), { disconnected: true }));
    }

    static list() {
      return Promise.resolve(state.listed().map((path) => ({ path })));
    }
  }

  return { SerialPort: FakeSerialPort };
});

import { execa } from 'execa';
import { rebootToBootsel, BOOTSEL_METHODS } from '../lib/bootsel.js';

const PORT = '/dev/ttyFAKE0';
const COMMAND = 'import machine; machine.bootloader()';

function isCommand(data) {
  return data.toString('latin1').includes(COMMAND);
}

// Board that answers Ctrl-C with a prompt and detaches shortly after the bootloader line.
function cooperativeRepl() {
  state.behavior.write = (port, data, callback) => {
    Promise.resolve().then(() => {
      callback(null);
      if (data[0] === 0x03) port.emit('data', Buffer.from('KeyboardInterrupt\r\n>>> '));
      if (isCommand(data)) setTimeout(() => port.disconnect(), 10);
    });
  };
}

async function settle(promise, ms) {
  const outcome = promise.then((value) => ({ value }), (error) => ({ error }));
  await vi.advanceTimersByTimeAsync(ms);
  return outcome;
}

describe('rebootToBootsel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.ports.length = 0;
    state.behavior = {};
    state.listed = () => [];
    vi.spyOn(fs, 'pathExists').mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exposes the default method order', () => {
    expect(BOOTSEL_METHODS).toEqual(['repl', 'touch1200', 'picotool']);
  });

  it('succeeds over the REPL when the port disconnects after machine.bootloader()', async () => {
    cooperativeRepl();
    const result = await rebootToBootsel({ path: PORT });

    expect(result).toEqual({ method: 'repl', output: expect.stringContaining('>>>') });
    const [port] = state.ports;
    expect(state.ports).toHaveLength(1);
    expect(port.options).toMatchObject({ path: PORT, autoOpen: false });
    expect([...port.written[0]]).toEqual([0x03, 0x03]);
    expect(port.written[1].toString('latin1')).toBe(`\x02\r\n${COMMAND}\r\n`);
    expect(port.isOpen).toBe(false);
    expect(execa).not.toHaveBeenCalled();
  });

  it('treats a write failure as success when the board detaches mid-write', async () => {
    state.behavior.write = (port, data, callback) => {
      Promise.resolve().then(() => {
        if (!isCommand(data)) return callback(null);
        port.disconnect();
        callback(new Error('Port is not open'));
      });
    };
    await expect(rebootToBootsel({ path: PORT, methods: ['repl'] })).resolves.toMatchObject({ method: 'repl' });
    expect(state.ports[0].isOpen).toBe(false);
  });

  it('accepts the device node disappearing as a detach even without a close event', async () => {
    let present = true;
    fs.pathExists.mockImplementation(async () => present);
    state.behavior.write = (port, data, callback) => {
      Promise.resolve().then(() => {
        callback(null);
        if (isCommand(data)) present = false;
      });
    };
    vi.useFakeTimers();
    const outcome = await settle(rebootToBootsel({ path: PORT, methods: ['repl'] }), 1000);
    expect(outcome.value).toMatchObject({ method: 'repl' });
    expect(fs.pathExists).toHaveBeenCalledWith(PORT);
    expect(state.ports[0].closeCalls).toBe(1);
    expect(state.ports[0].isOpen).toBe(false);
  });

  it('falls through a failed REPL and 1200-baud touch to picotool', async () => {
    state.listed = () => [PORT];
    state.behavior.open = (port, finish) => {
      Promise.resolve().then(() => finish(port.options.baudRate === 115200 ? new Error('Access denied') : null));
    };
    execa.mockResolvedValue({ stdout: 'Rebooting device\n' });
    vi.useFakeTimers();

    const outcome = await settle(rebootToBootsel({ path: PORT, serialNumber: 'E660' }), 5000);

    expect(outcome.value).toEqual({ method: 'picotool', output: 'Rebooting device' });
    expect(state.ports.map((port) => port.options.baudRate)).toEqual([115200, 1200]);
    const touch = state.ports[1];
    expect(touch.setCalls).toEqual([{ dtr: false, rts: false }]);
    expect(touch.closeCalls).toBe(1);
    expect(touch.isOpen).toBe(false);
    expect(execa).toHaveBeenCalledWith('picotool', ['reboot', '-u', '-f', '--ser', 'E660'], { timeout: 7000 });
  });

  it('reports a 1200-baud touch as successful once the port disappears', async () => {
    let listed = true;
    state.listed = () => (listed ? [PORT] : []);
    state.behavior.open = (port, finish) => {
      port.once('close', () => { listed = false; });
      Promise.resolve().then(() => finish(null));
    };
    vi.useFakeTimers();
    const outcome = await settle(rebootToBootsel({ path: PORT, methods: ['touch1200'] }), 500);

    expect(outcome.value).toEqual({ method: 'touch1200', output: '' });
    expect(state.ports[0].options.baudRate).toBe(1200);
    expect(state.ports[0].isOpen).toBe(false);
  });

  it('honours an explicit method order and stops at the first success', async () => {
    execa.mockResolvedValue({ stdout: 'ok' });
    await expect(rebootToBootsel({ path: PORT, methods: ['picotool', 'repl'] }))
      .resolves.toEqual({ method: 'picotool', output: 'ok' });
    expect(state.ports).toHaveLength(0);
  });

  it('skips serial methods without a path and never filters by vendor ID', async () => {
    execa.mockResolvedValue({ stdout: 'ok' });
    await expect(rebootToBootsel({ bus: 1, address: 4 })).resolves.toEqual({ method: 'picotool', output: 'ok' });
    expect(state.ports).toHaveLength(0);
    expect(execa).toHaveBeenCalledWith('picotool', ['reboot', '-u', '-f', '--bus', '1', '--address', '4'], { timeout: 10000 });

    await expect(rebootToBootsel({ methods: ['repl', 'touch1200'] })).rejects.toThrow(TypeError);
  });

  it('validates inputs before touching any device', async () => {
    const invalid = [
      [null, /options/],
      [{ path: '' }, /path/],
      [{ path: 42 }, /path/],
      [{ serialNumber: '' }, /serialNumber/],
      [{ drive: 'E:' }, /drive.*not supported/i],
      [{ methods: [] }, /methods/],
      [{ methods: 'repl' }, /methods/],
      [{ methods: ['repl', 'bogus'] }, /Unknown BOOTSEL method: bogus/],
      [{ methods: ['repl', 'repl'] }, /more than once/]
    ];
    for (const [options, pattern] of invalid) {
      await expect(rebootToBootsel(options)).rejects.toThrow(TypeError);
      await expect(rebootToBootsel(options)).rejects.toThrow(pattern);
    }
    for (const timeout of [0, -1, '100', 1.5, Infinity]) {
      await expect(rebootToBootsel({ path: PORT, timeout })).rejects.toThrow(/timeout/i);
    }
    expect(state.ports).toHaveLength(0);
    expect(execa).not.toHaveBeenCalled();
  });

  it('closes the port and falls through when the REPL never disconnects, passing on the remaining budget', async () => {
    execa.mockResolvedValue({ stdout: '' });
    vi.useFakeTimers();
    const outcome = await settle(rebootToBootsel({ path: PORT, methods: ['repl', 'picotool'], timeout: 5000 }), 5000);

    expect(outcome.value).toEqual({ method: 'picotool', output: '' });
    const [port] = state.ports;
    expect(port.closeCalls).toBe(1);
    expect(port.isOpen).toBe(false);
    // 500 ms prompt wait + 3000 ms detach window leave 1500 ms of the shared budget.
    expect(execa).toHaveBeenCalledWith('picotool', ['reboot', '-u', '-f'], { timeout: 1500 });
  });

  it('enforces the total timeout across attempts and closes an open that lands late', async () => {
    let landOpen;
    state.behavior.open = (port, finish) => { landOpen = finish; };
    vi.useFakeTimers();
    const outcome = await settle(rebootToBootsel({ path: PORT, timeout: 200 }), 200);

    expect(outcome.error).toMatchObject({ code: 'ETIMEDOUT', errors: [{ method: 'repl', message: `Timed out opening ${PORT}.` }] });
    expect(outcome.error.message).toMatch(/exhausted before touch1200, picotool/);
    expect(execa).not.toHaveBeenCalled();
    expect(state.ports).toHaveLength(1);

    landOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.ports[0].closeCalls).toBe(1);
    expect(state.ports[0].isOpen).toBe(false);
  });

  it('closes the port when a write fails before the bootloader command', async () => {
    state.behavior.write = (port, data, callback) => Promise.resolve().then(() => callback(new Error('EIO')));
    execa.mockResolvedValue({ stdout: '' });
    await expect(rebootToBootsel({ path: PORT, methods: ['repl', 'picotool'] })).resolves.toMatchObject({ method: 'picotool' });
    expect(state.ports[0].written).toHaveLength(1);
    expect(state.ports[0].closeCalls).toBe(1);
    expect(state.ports[0].isOpen).toBe(false);
  });

  it('aggregates one error per attempt when every method fails', async () => {
    state.behavior.open = (port, finish) => Promise.resolve().then(() => finish(new Error('Resource busy')));
    execa.mockRejectedValue(Object.assign(new Error('spawn picotool ENOENT'), { code: 'ENOENT' }));

    const error = await rebootToBootsel({ path: PORT }).catch((reason) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBeUndefined();
    expect(error.errors).toEqual([
      { method: 'repl', message: 'Resource busy' },
      { method: 'touch1200', message: expect.stringMatching(/Cannot observe whether .* detaches/) },
      { method: 'picotool', message: 'picotool is not installed or not available on the PATH.' }
    ]);
    expect(error.message).toMatch(/repl: Resource busy; touch1200: .*; picotool: picotool is not installed/);
    expect(state.ports).toHaveLength(1);
  });
});
