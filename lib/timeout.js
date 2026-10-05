const MAX_TIMEOUT = 2147483647;

export function normalizeTimeout(value, fallback) {
  if (value === undefined) value = fallback;
  if (value === undefined) return undefined;
  if (typeof value !== 'number') {
    throw new TypeError('Timeout must be a number of milliseconds.');
  }
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT) {
    throw new RangeError(`Timeout must be an integer from 1 to ${MAX_TIMEOUT} milliseconds.`);
  }
  return value;
}
