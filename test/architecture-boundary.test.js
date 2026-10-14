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

test('normal runtime has one fact path, with no retired whole-state bridge', () => {
  const retired = ['SquareDoc', 'createSquareDoc', 'readDocument', 'transactSquareSnapshot', 'deriveDeliveryModel', 'replayLandedAudiences', 'cloneState'];
  const leaks = retired.flatMap((identifier) => ownershipLeaks(identifier, []));
  assert.deepEqual(leaks, [], `retired whole-state runtime API:\n${leaks.join('\n')}`);
  const stateOwners = ['model.ts', 'square-state.ts', 'artifact.ts', 'square-storage.ts', 'square-sqlite.ts', 'square-file-adapter.ts', 'square-migration.ts'];
  assert.deepEqual(ownershipLeaks('SquareState', stateOwners), []);
});

test('artifact storage has one production import boundary', () => {
  const bypasses = filesContaining(
    /from ['"](?:\.\.\/)*artifact\.js['"]/,
    ['artifact.ts', 'square-storage.ts'],
  );
  assert.deepEqual(bypasses, [], `production modules bypass square-storage.ts: ${bypasses.join(', ')}`);
});

test('one canonicalizer owns square location keys', () => {
  const realpathEscapes = filesContaining(/realpath/, ['canonical-path.ts', 'presentation.ts', 'harness-links.ts']);
  assert.deepEqual(realpathEscapes, [], `square location canonicalization escaped canonical-path.ts: ${realpathEscapes.join(', ')}`);

  const retired = ['canonicalSquarePath', 'canonicalFilePath', 'canonicalRouteLocation', 'canonicalRouteLocationSync', 'canonRoot', 'SessionChannel'];
  const leaks = retired.flatMap((identifier) => ownershipLeaks(identifier, []));
  assert.deepEqual(leaks, [], `retired canonicalization or channel names survived:\n${leaks.join('\n')}`);
});

test('SQLite artifact rows stay private to storage framing and explicit migration', () => {
  const boundary = ['artifact.ts', 'square-sqlite.ts', 'square-state.ts', 'square-migration.ts'];
  assert.deepEqual(filesContaining(/from ['"]node:sqlite['"]/, [...boundary, 'file-lock.ts']), []);
  const driver = productionSources.get('square-sqlite.ts') ?? '';
  assert.match(driver, /CREATE TABLE landed_audience/);
  assert.doesNotMatch(driver, /CREATE (?:TRIGGER|VIEW|VIRTUAL TABLE)/);
  for (const identifier of ['square_snapshot', 'square_meta', 'landed_audience', 'application_id', 'user_version']) {
    assert.deepEqual(ownershipLeaks(identifier, boundary), [], `${identifier} escaped the artifact boundary`);
  }
});

test('artifact callbacks are synchronous typed capabilities, not replacement snapshots', () => {
  const source = productionSources.get('ports.ts') ?? '';
  assert.match(source, /read<R>\(select: \(facts: SquareRead\) => R,/);
  assert.match(source, /transact<R>\(change: \(facts: SquareWrite\) => R,/);
  assert.doesNotMatch(source, /SquareState|state\?:/);
});

test('raw file state APIs stay inside storage and the file artifact adapter', () => {
  const storageAndFileAdapter = ['square-storage.ts', 'square-file-adapter.ts'];
  const leaks = [
    ...ownershipLeaks('probeSquareFile', storageAndFileAdapter),
    ...ownershipLeaks('createMemoryCell', storageAndFileAdapter),
    ...ownershipLeaks('createFileCell', storageAndFileAdapter),
  ];
  assert.deepEqual(leaks, [], `raw file state API escaped its owner boundary:\n${leaks.join('\n')}`);
});

test('the artifact contract comes from ports.ts alone', () => {
  const storage = productionSources.get('square-storage.ts') ?? '';
  assert.match(
    storage,
    /import type \{[^}]*\bSquareArtifactPort\b[^}]*\} from '\.\/ports\.js';/,
    'square-storage.ts must implement the declared SquareArtifactPort',
  );
  const duplicateContracts = filesContaining(
    /(?:interface|type)\s+\w*(?:Cell|ArtifactPort)\b/,
    ['ports.ts'],
  );
  assert.deepEqual(
    duplicateContracts,
    [],
    `storage machinery re-declares the artifact contract:\n${duplicateContracts.join('\n')}`,
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
  for (const identifier of ['SquareState', 'probeSquareFile', 'createMemoryCell', 'createFileCell']) {
    if (new RegExp(`\\b${identifier}\\b`).test(observation)) {
      leaks.push(`${identifier}: cli/observation-commands.ts`);
    }
  }
  assert.deepEqual(leaks, [], `CLI observation bypasses concern projections:\n${leaks.join('\n')}`);
});

test('decisions and perception use domain facts, outside host and storage operations', () => {
  for (const file of ['decisions.ts', 'catch-decisions.ts', 'perception-projection.ts']) {
    const source = productionSources.get(file);
    assert.ok(source, `${file} must be part of production sources`);
    assert.doesNotMatch(source, /SquareArtifactPort|HostLedgerPort|\.artifact\.|\.transact\s*\(/, file);
    assert.doesNotMatch(source, /from ['"](?:node:|\.\/(?:artifact|square-storage|square-actions|participant-host|registry)\.js)/, file);
  }
  const actions = productionSources.get('square-actions.ts') ?? '';
  assert.doesNotMatch(actions, /CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID|OPENCODE_SESSION_ID|PI_SESSION_ID|PASEO_AGENT_ID/);
});

test('product adapters stay behind the facade and close boundary', () => {
  const directClose = filesContaining(/\bartifact\.close\s*\(/, ['open-square.ts', 'square-file-adapter.ts', 'inbox.ts']);
  assert.deepEqual(directClose, [], `artifact close escaped its package-private boundary: ${directClose.join(', ')}`);
  // The application layer coordinates the same actions the facade forwards to; product
  // adapters (CLI, harnesses, mods) must still reach participant mutation through Square.
  const actionBypasses = filesContaining(/from ['"](?:\.\/|\.\.\/)square-actions\.js['"]/, ['square-wiring.ts', 'square-application.ts']);
  assert.deepEqual(actionBypasses, [], `participant mutation bypasses Square/Participant facade: ${actionBypasses.join(', ')}`);
  const presenceBypasses = filesContaining(/from ['"](?:\.\/|\.\.\/)presence\.js['"]/, ['square-wiring.ts']);
  assert.deepEqual(presenceBypasses, [], `boundary acknowledgement bypasses facade: ${presenceBypasses.join(', ')}`);
});
