#!/usr/bin/env node
import { Bridge } from './bridge.js';
import { loadConfig } from './config.js';
import { createSlackSdkPort } from './slack-sdk-port.js';

const USAGE = 'usage: square-slack-bridge --config <file>';

async function main(argv: readonly string[]): Promise<void> {
  let configFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--config') {
      configFile = argv[index + 1];
      index += 1;
    }
    else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    else refuse(`unknown argument ${argument}\n${USAGE}`);
  }
  if (configFile === undefined) refuse(`--config is required\n${USAGE}`);
  const settings = await loadConfig(configFile).catch((error: unknown) => refuse(describe(error)));
  const bridge = await Bridge.open({ settings, port: createSlackSdkPort() }).catch((error: unknown) => refuse(describe(error)));
  await bridge.start().catch((error: unknown) => refuse(`cannot connect to Slack: ${describe(error)}`));
  process.stderr.write(`square-slack-bridge: ${settings.square} ↔ ${settings.channel}\n`);
  const stop = (): void => {
    void bridge.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`square-slack-bridge: ${describe(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function refuse(message: string): never {
  process.stderr.write(`square-slack-bridge: ${message}\n`);
  process.exit(1);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main(process.argv.slice(2));
