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

test('StateCell access stays inside storage and its three transactional concerns', () => {
  const owners = ['state-cell.ts', 'square-storage.ts', 'square-file-adapter.ts', 'landing.ts', 'presence.ts', 'wakes.ts'];
  const directTransactions = filesContaining(
    /\b(?:this\.)?cell\s*\.\s*transact\s*(?:<[^()]*>)?\s*\(/,
    owners,
  );
  const directReads = filesContaining(
    /\b(?:this\.)?cell\s*\.\s*read\s*(?:<[^()]*>)?\s*\(/,
    [...owners, 'views.ts'],
  );
  const leaks = [
    ...ownershipLeaks('StateCell', ['state-cell.ts', 'square-storage.ts', 'square-file-adapter.ts', 'open-square.ts']),
    ...directTransactions.map((file) => `direct transact: ${file}`),
    ...directReads.map((file) => `direct read: ${file}`),
  ];
  assert.deepEqual(
    leaks,
    [],
    `raw StateCell access escaped its concern boundary:\n${leaks.join('\n')}`,
  );
});

test('CLI observation consumes concern projections, not state or domain law', () => {
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
  assert.deepEqual(leaks, [], `CLI observation bypasses concern projections:\n${leaks.join('\n')}`);
});

test('the collector vocabulary and engine are gone', () => {
  assert.equal(fs.existsSync(path.join(root, 'square-engine.ts')), false);
  const stale = ['Square' + 'Application', 'create' + 'Application', 'openFile' + 'Application', 'probeFile' + 'Application', 'buildFile' + 'Application', 'buildMemory' + 'Application', 'Application' + 'BuildOptions']
    .flatMap((identifier) => filesContaining(new RegExp(`\\b${identifier}\\b`)).map((file) => `${identifier}: ${file}`));
  assert.deepEqual(stale, []);
});

test('the removed archive compaction protocol leaves no residue', () => {
  const sources = new Map([
    ...productionSources,
    ...fs.readdirSync(path.join(root, 'test'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => [`test/${entry.name}`, fs.readFileSync(path.join(root, 'test', entry.name), 'utf8')]),
  ]);
  const removed = [
    ['SQ', 'ARCH01'].join(''),
    ['encode', 'Archive'].join(''),
    ['decode', 'Archive'].join(''),
    ['write', 'ArchiveFile'].join(''),
    ['load', 'Archive'].join(''),
    ['core', 'Compact'].join(''),
    ['Compact', 'Result'].join(''),
    ['compact', 'Square'].join(''),
    ['compact', 'FileSquare'].join(''),
    ['.', 'archive', '.square'].join(''),
  ];
  const leaks = removed.flatMap((identifier) => [...sources]
    .filter(([, source]) => source.includes(identifier))
    .map(([file]) => `${identifier}: ${file}`));
  assert.deepEqual(leaks, [], `removed archive compaction residue:\n${leaks.join('\n')}`);
});

test('watch terminal law and notifier type each have one directional owner', () => {
  const runtime = productionSources.get('runtime.ts') ?? '';
  const facade = productionSources.get('square-facade.ts') ?? '';
  const binding = productionSources.get('open-square.ts') ?? '';
  const concerns = ['landing.ts', 'presence.ts', 'views.ts', 'wakes.ts'];
  assert.equal((runtime.match(/function watchTerminalStatus\b/g) ?? []).length, 1);
  assert.equal(concerns.filter((file) => /function watchTerminalStatus\b/.test(productionSources.get(file) ?? '')).length, 0);
  assert.equal((facade.match(/interface WakeNotifier\b/g) ?? []).length, 1);
  assert.match(binding, /import type \{ WakeNotifier \} from ['"]\.\/square-facade\.js['"]/);
  assert.doesNotMatch(facade, /open-square\.js/);
  for (const concern of concerns) {
    assert.doesNotMatch(productionSources.get(concern) ?? '', /from ['"]\.\/(?:landing|presence|views|wakes)\.js['"]/);
  }
});

test('product adapters stay behind the facade and close boundary', () => {
  const directClose = filesContaining(/\.cell\.close\s*\(/, ['open-square.ts']);
  assert.deepEqual(directClose, [], `StateCell close escaped its package-private boundary: ${directClose.join(', ')}`);
  const landingBypasses = filesContaining(/from ['"](?:\.\/|\.\.\/)landing\.js['"]/, ['square-wiring.ts']);
  assert.deepEqual(landingBypasses, [], `participant mutation bypasses Square/Participant facade: ${landingBypasses.join(', ')}`);
  const presenceBypasses = filesContaining(/from ['"](?:\.\/|\.\.\/)presence\.js['"]/, ['square-wiring.ts']);
  assert.deepEqual(presenceBypasses, [], `participant consumption bypasses Square/Participant facade: ${presenceBypasses.join(', ')}`);
});
