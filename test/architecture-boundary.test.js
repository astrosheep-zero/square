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

test('artifact storage has one production import boundary', () => {
  const bypasses = filesContaining(
    /from ['"](?:\.\.\/)*artifact\.js['"]/,
    ['artifact.ts', 'square-storage.ts'],
  );
  assert.deepEqual(bypasses, [], `production modules bypass square-storage.ts: ${bypasses.join(', ')}`);
});

test('SQLite snapshot ownership stays at the artifact boundary', () => {
  const sqliteImports = filesContaining(/from ['"]node:sqlite['"]/, ['artifact.ts', 'file-lock.ts']);
  assert.deepEqual(sqliteImports, [], `SQLite escaped its storage owners: ${sqliteImports.join(', ')}`);

  const artifact = productionSources.get('artifact.ts') ?? '';
  assert.match(artifact, /from ['"]node:sqlite['"]/);
  for (const identifier of ['square_snapshot', 'application_id', 'user_version']) {
    assert.match(artifact, new RegExp(`\\b${identifier}\\b`), `artifact.ts must own ${identifier}`);
    assert.deepEqual(
      ownershipLeaks(identifier, ['artifact.ts']),
      [],
      `${identifier} escaped artifact.ts`,
    );
  }
});

test('artifact port transactions accept synchronous state transitions only', () => {
  for (const file of ['ports.ts', 'state-cell.ts']) {
    const source = productionSources.get(file) ?? '';
    const signature = source.match(/transact<R>\(fn:[\s\S]*?\): Promise<R>;/)?.[0];
    assert.ok(signature, `${file} must declare StateCell transaction access`);
    const callback = signature.slice(0, signature.lastIndexOf('): Promise<R>;'));
    assert.doesNotMatch(callback, /\bPromise(?:Like)?\b/, `${file} lets an asynchronous transition cross the port`);
  }
});

test('raw file state APIs stay inside storage and the file artifact adapter', () => {
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

test('StateCell stays below the artifact adapter', () => {
  const owners = ['state-cell.ts', 'square-storage.ts', 'square-file-adapter.ts'];
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

test('decisions and perception stay state-only, outside host and storage operations', () => {
  for (const file of ['decisions.ts', 'catch-decisions.ts', 'perception-projection.ts']) {
    const source = productionSources.get(file);
    assert.ok(source, `${file} must be part of production sources`);
    assert.doesNotMatch(source, /SquareArtifactPort|HostLedgerPort|\.artifact\.|\.transact\s*\(/, file);
    assert.doesNotMatch(source, /from ['"](?:node:|\.\/(?:artifact|square-storage|square-actions|participant-host|registry)\.js)/, file);
  }
  const actions = productionSources.get('square-actions.ts') ?? '';
  assert.doesNotMatch(actions, /CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID|OPENCODE_SESSION_ID|SQUARE_PI_SESSION_ID|PASEO_AGENT_ID/);
});

test('product adapters stay behind the facade and close boundary', () => {
  const directClose = filesContaining(/\.cell\.close\s*\(/, ['open-square.ts']);
  assert.deepEqual(directClose, [], `StateCell close escaped its package-private boundary: ${directClose.join(', ')}`);
  const actionBypasses = filesContaining(/from ['"](?:\.\/|\.\.\/)square-actions\.js['"]/, ['square-wiring.ts']);
  assert.deepEqual(actionBypasses, [], `participant mutation bypasses Square/Participant facade: ${actionBypasses.join(', ')}`);
  const presenceBypasses = filesContaining(/from ['"](?:\.\/|\.\.\/)presence\.js['"]/, ['square-wiring.ts']);
  assert.deepEqual(presenceBypasses, [], `boundary acknowledgement bypasses facade: ${presenceBypasses.join(', ')}`);
});
