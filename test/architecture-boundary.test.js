import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir, relative = '', recursive = true) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const nextRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) return recursive ? sourceFiles(path.join(dir, entry.name), nextRelative) : [];
    return entry.name.endsWith('.ts') ? [nextRelative] : [];
  });
}

// Keep this aligned with tsconfig.json's production includes.
const productionFiles = [
  ...sourceFiles(root, '', false),
  ...sourceFiles(path.join(root, 'cmd'), 'cmd'),
  ...sourceFiles(path.join(root, 'cli'), 'cli'),
].sort();
const productionSources = new Map(
  productionFiles.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]),
);

function filesContaining(pattern, allowed = []) {
  const allowlist = new Set(allowed);
  return [...productionSources]
    .filter(([file, source]) => !allowlist.has(file) && pattern.test(source))
    .map(([file]) => file);
}

function ownershipLeaks(identifier, owners) {
  return filesContaining(new RegExp(`\\b${identifier}\\b`), owners)
    .map((file) => `${identifier}: ${file}`);
}

test('the internal aggregate is state, never a document', () => {
  const leaks = [
    ...ownershipLeaks('SquareDoc', []),
    ...ownershipLeaks('createSquareDoc', []),
    ...ownershipLeaks('readDocument', []),
  ];
  assert.deepEqual(leaks, [], `stale document-shaped aggregate API:\n${leaks.join('\n')}`);
});

test('artifact bytes have one production import boundary', () => {
  const bypasses = filesContaining(
    /from ['"](?:\.\.\/)*artifact\.js['"]/,
    ['artifact.ts', 'square-storage.ts'],
  );
  assert.deepEqual(bypasses, [], `production modules bypass square-storage.ts: ${bypasses.join(', ')}`);
});

test('raw file state APIs stay inside storage and the file application adapter', () => {
  const storageAndFileAdapter = ['square-storage.ts', 'square-file-adapter.ts'];
  const leaks = [
    ...ownershipLeaks('readSquareFile', storageAndFileAdapter),
    ...ownershipLeaks('probeSquareFile', storageAndFileAdapter),
    ...ownershipLeaks('openSquareCell', storageAndFileAdapter),
    ...ownershipLeaks('createMemoryCell', storageAndFileAdapter),
    ...ownershipLeaks('createFileCell', ['square-storage.ts']),
  ];
  assert.deepEqual(leaks, [], `raw file state API escaped its owner boundary:\n${leaks.join('\n')}`);
});

test('StateCell access stays inside its storage and application owners', () => {
  const owners = ['square-engine.ts', 'square-storage.ts', 'square-file-adapter.ts'];
  const directAccess = filesContaining(
    /\b(?:this\.)?cell\s*\.\s*(?:transact|read)\s*(?:<[^()]*>)?\s*\(/,
    owners,
  );
  const leaks = [
    ...ownershipLeaks('StateCell', ['square-engine.ts', 'square-storage.ts']),
    ...directAccess.map((file) => `direct transact/read: ${file}`),
  ];
  assert.deepEqual(
    leaks,
    [],
    `raw StateCell access escaped the application boundary:\n${leaks.join('\n')}`,
  );
});

test('CLI observation consumes application projections, not the aggregate', () => {
  const cliObservationFiles = productionFiles.filter((file) => file.startsWith(`cli${path.sep}`));
  const leaks = ['coreActivities', 'coreParticipants', 'coreStatus'].flatMap((identifier) =>
    cliObservationFiles
      .filter((file) => new RegExp(`\\b${identifier}\\b`).test(productionSources.get(file)))
      .map((file) => `${identifier}: ${file}`)
  );
  for (const file of cliObservationFiles) {
    if (/from\s+['"]\.\.\/square-core\.js['"]/.test(productionSources.get(file))) {
      leaks.push(`square-core import: ${file}`);
    }
  }

  const observation = productionSources.get(path.join('cli', 'observation-commands.ts'));
  assert.ok(observation, 'cli/observation-commands.ts must be part of the production sources');
  for (const identifier of ['SquareState', 'StateCell', 'readSquareFile', 'probeSquareFile', 'openSquareCell']) {
    if (new RegExp(`\\b${identifier}\\b`).test(observation)) {
      leaks.push(`${identifier}: cli/observation-commands.ts`);
    }
  }
  assert.deepEqual(leaks, [], `CLI observation bypasses application projections:\n${leaks.join('\n')}`);
});
