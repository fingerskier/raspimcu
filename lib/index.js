const devices = require('./devices');
const fileTransfer = require('./fileTransfer');
const firmware = require('./firmware');
const picotool = require('./picotool');

module.exports = {
  ...devices,
  ...fileTransfer,
  ...firmware,
  ...picotool
};
