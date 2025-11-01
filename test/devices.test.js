import { describe, it, expect } from 'vitest';
import { isRp2040Device, filterRp2040Devices } from '../lib/devices.js';

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
});
