#!/usr/bin/env node

const { runCli } = require('../lib/cli');

runCli(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error && process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});
