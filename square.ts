#!/usr/bin/env node

import { runCli } from './cli/program.js';

try {
  await runCli();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
