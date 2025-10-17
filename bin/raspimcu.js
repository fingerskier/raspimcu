#!/usr/bin/env node

import { runCli } from '../lib/cli.js';

runCli(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error && process.env.DEBUG) {
    console.error(error.stack);
  }
  process.exit(1);
});
