let serialPortModulePromise;

// serialport is a native addon; resolve null instead of throwing so callers
// can report a friendly error (or fall back) when it cannot load.
async function loadSerialPort() {
  if (!serialPortModulePromise) {
    serialPortModulePromise = import('serialport')
      .then((module) => module.SerialPort)
      .catch(() => null);
  }
  return serialPortModulePromise;
}

export { loadSerialPort };
