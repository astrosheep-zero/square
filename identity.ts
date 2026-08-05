import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

function packageManifest(): PackageManifest {
  const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object') throw new Error(`Invalid package manifest: ${packagePath}`);
  return parsed as PackageManifest;
}

const manifest = packageManifest();
if (manifest.name !== '@astrosheep/square' || typeof manifest.version !== 'string') {
  throw new Error('Square package identity is invalid.');
}

export const SQUARE_IDENTITY = Object.freeze({
  publisher: 'astrosheep',
  packageName: manifest.name,
  packageVersion: manifest.version,
  productName: 'Square',
  pluginName: 'square',
  marketplaceName: 'astrosheep',
  cliName: 'square',
  pluginId: 'square@astrosheep',
  hookCommand: 'square codex-hook',
  hookMarker: 'square-codex-hook',
  clientName: 'astrosheep_square',
});
