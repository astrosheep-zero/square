import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const manifests = [
  'claude-plugin/.claude-plugin/plugin.json',
  'codex-plugin/.codex-plugin/plugin.json',
];

const changed = [];
for (const rel of manifests) {
  const file = path.join(root, rel);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (json.version === version) continue;
  json.version = version;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  changed.push(rel);
  console.log(`${rel} -> ${version}`);
}

if (changed.length === 0) {
  console.log('plugin manifests already at ' + version);
}

if (process.argv.includes('--commit') && changed.length > 0) {
  execFileSync('git', ['add', ...changed], { stdio: 'inherit', cwd: root });
  execFileSync('git', ['commit', '-m', `Sync plugin manifests for ${version}`], { stdio: 'inherit', cwd: root });
}
