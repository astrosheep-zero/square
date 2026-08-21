import fs from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';

import { SQUARE_IDENTITY } from './identity.js';

export interface PiCommandResult { status: number; stdout: string; stderr: string; }
export type PiCommandRunner = (homeDir: string, args: string[]) => PiCommandResult;

export function piPackageSource(): string {
  return `npm:${SQUARE_IDENTITY.packageName}@${SQUARE_IDENTITY.packageVersion}`;
}

export function piPackageRoot(homeDir: string): string {
  return path.join(homeDir, '.pi', 'agent', 'npm', 'node_modules', ...SQUARE_IDENTITY.packageName.split('/'));
}

function runPi(homeDir: string, args: string[]): PiCommandResult {
  const result = crossSpawn.sync(process.env.SQUARE_PI_BIN || 'pi', args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function requireSuccess(result: PiCommandResult, action: string): void {
  if (result.status === 0) return;
  throw new Error(`Pi ${action} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`);
}

export function installPiPackage(homeDir: string, run: PiCommandRunner = runPi): string[] {
  requireSuccess(run(homeDir, ['install', piPackageSource()]), 'package install');
  return [piPackageRoot(homeDir)];
}

export function uninstallPiPackage(homeDir: string, run: PiCommandRunner = runPi): string[] {
  requireSuccess(run(homeDir, ['remove', piPackageSource()]), 'package removal');
  return [piPackageRoot(homeDir)];
}

export function doctorPiPackage(homeDir: string, run: PiCommandRunner = runPi): string[] {
  const listed = run(homeDir, ['list']);
  const root = piPackageRoot(homeDir);
  const manifestPath = path.join(root, 'package.json');
  let manifest: { version?: unknown; pi?: { extensions?: unknown } } | undefined;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as typeof manifest;
  } catch {
    // The diagnostics below name the missing or invalid package state.
  }
  const extensions = manifest?.pi?.extensions;
  return [
    listed.status === 0 && listed.stdout.includes(SQUARE_IDENTITY.packageName)
      ? `✓ Pi package ${SQUARE_IDENTITY.packageName} configured`
      : `○ Pi package ${SQUARE_IDENTITY.packageName} not configured`,
    manifest?.version === SQUARE_IDENTITY.packageVersion
      ? `✓ Pi package ${SQUARE_IDENTITY.packageVersion} installed at ${root}`
      : `○ Pi package ${SQUARE_IDENTITY.packageVersion} missing at ${root}`,
    Array.isArray(extensions) && extensions.includes('./extensions/square-pi.js')
      ? '✓ Pi Square extension declared'
      : '○ Pi Square extension not declared',
  ];
}
