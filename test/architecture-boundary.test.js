import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir, relative = '', recursive = true) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const nextRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) return recursive && !['test', 'tests', 'node_modules'].includes(entry.name) ? sourceFiles(path.join(dir, entry.name), nextRelative) : [];
    return /\.(?:ts|js|mjs)$/.test(entry.name) ? [nextRelative] : [];
  });
}

// Include separately compiled native integrations, not just tsconfig's roots.
const productionFiles = [
  ...sourceFiles(root, '', false),
  ...sourceFiles(path.join(root, 'cmd'), 'cmd'),
  ...sourceFiles(path.join(root, 'cli'), 'cli'),
  ...sourceFiles(path.join(root, 'plugins'), 'plugins'),
  ...sourceFiles(path.join(root, 'packages/agent-delivery/src'), 'packages/agent-delivery/src'),
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
  const stateOwners = ['artifact.ts', 'square-sqlite.ts', 'square-migration.ts'];
  assert.deepEqual(ownershipLeaks('SquareState', stateOwners), []);
});

function resolvedTarget(file, module) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), module)).replace(/\.js$/, '.ts');
}

function storageLeaks(sources) {
  const artifactBindings = new Map([
    ['open-square.ts', ['createArtifactPort', 'createSquare', 'prepareSquareBuild']],
    ['sqlite-square.ts', ['createSquare', 'diagnoseSquareFile']],
    ['inbox.ts', ['createArtifactPort', 'observeSquareRevision']],
    ['ledger-maintenance.ts', ['createArtifactPort']],
    ['stream.ts', ['observeSquareRevision']],
    ['square-migration.ts', ['openExistingSquareDatabase']],
  ]);
  const leaks = [];
  for (const [file, source] of sources) {
    for (const edge of moduleEdges(file, source)) {
      if (!edge.module.startsWith('.')) continue;
      const target = resolvedTarget(file, edge.module);
      if (target === 'artifact.ts') {
        const allowed = artifactBindings.get(file) ?? [];
        const allowedTypes = file === 'square-facade.ts' ? ['DiagnoseResult'] : [];
        if (edge.names.some(name => !allowed.includes(name)) || edge.types.some(name => !allowedTypes.includes(name)))
          leaks.push(`${file} -> ${target}`);
      }
      if (target === 'square-sqlite.ts' && !['artifact.ts', 'square-migration.ts'].includes(file))
        leaks.push(`${file} -> ${target}`);
      if (target === 'host-ledger-sqlite.ts' && !['host-ledger-file-adapter.ts', 'host-ledger-migration.ts'].includes(file))
        leaks.push(`${file} -> ${target}`);
      if (target === 'sqlite-transaction.ts' && !['artifact.ts', 'square-migration.ts', 'host-ledger-sqlite.ts', 'host-ledger-migration.ts'].includes(file))
        leaks.push(`${file} -> ${target}`);
    }
  }
  return leaks.sort();
}

test('resolved imports preserve artifact and SQL ownership across native integrations', () => {
  assert.ok(productionSources.has('plugins/opencode/delivery.ts'));
  assert.ok(productionSources.has('packages/agent-delivery/src/opencode-native.ts'));
  assert.deepEqual(storageLeaks(productionSources), []);
  assert.deepEqual(storageLeaks(new Map([
    ['native.ts', "import { createArtifactPort } from './artifact.js';"],
    ['plugins/opencode/helper.ts', "export { createSqliteDriver } from '../../square-sqlite.js';"],
    ['open-square.ts', "export { createSqliteDriver } from './square-sqlite.js';"],
    ['cli/hidden.ts', "import { withLedger } from '../host-ledger-sqlite.js';"],
    ['decisions.ts', "import { inSqliteTransaction } from './sqlite-transaction.js';"],
  ])), ['cli/hidden.ts -> host-ledger-sqlite.ts', 'decisions.ts -> sqlite-transaction.ts', 'native.ts -> artifact.ts', 'open-square.ts -> square-sqlite.ts', 'plugins/opencode/helper.ts -> square-sqlite.ts']);
});

test('one canonicalizer owns square location keys', () => {
  const realpathEscapes = filesContaining(/realpath/, ['canonical-path.ts', 'presentation.ts', 'harness-links.ts']);
  assert.deepEqual(realpathEscapes, [], `square location canonicalization escaped canonical-path.ts: ${realpathEscapes.join(', ')}`);

  const retired = ['canonicalSquarePath', 'canonicalFilePath', 'canonicalRouteLocation', 'canonicalRouteLocationSync', 'canonRoot', 'SessionChannel'];
  const leaks = retired.flatMap((identifier) => ownershipLeaks(identifier, []));
  assert.deepEqual(leaks, [], `retired canonicalization or channel names survived:\n${leaks.join('\n')}`);
});

test('SQLite artifact rows stay private to storage framing and explicit migration', () => {
  const boundary = ['artifact.ts', 'square-sqlite.ts', 'square-migration.ts'];
  assert.deepEqual(filesContaining(/from ['"]node:sqlite['"]/, [...boundary, 'file-lock.ts', 'host-ledger-sqlite.ts', 'host-ledger-migration.ts', 'sqlite-transaction.ts']), []);
  const driver = productionSources.get('square-sqlite.ts') ?? '';
  assert.match(driver, /CREATE TABLE landed_audience/);
  assert.doesNotMatch(driver, /CREATE (?:TRIGGER|VIEW|VIRTUAL TABLE)/);
  for (const identifier of ['square_snapshot', 'square_meta', 'landed_audience']) {
    assert.deepEqual(ownershipLeaks(identifier, boundary), [], `${identifier} escaped the artifact boundary`);
  }
  for (const identifier of ['application_id', 'user_version']) {
    assert.deepEqual(ownershipLeaks(identifier, [...boundary, 'host-ledger-sqlite.ts']), [], `${identifier} escaped storage framing`);
  }
});

test('host ledger SQL and derived lookup columns stay private to its storage codec', () => {
  for (const identifier of ['host_meta', 'host_presence', 'host_evidence', 'row_json', 'presence_revision', 'evidence_revision', 'claim_token_key', 'effective_at']) {
    assert.deepEqual(ownershipLeaks(identifier, ['host-ledger-sqlite.ts']), [], `${identifier} escaped host ledger storage`);
  }
  const transaction = productionSources.get('sqlite-transaction.ts') ?? '';
  assert.doesNotMatch(transaction, /host-ledger|square-sqlite|host_meta|square_meta/, 'busy retry and transaction lifetime have no schema owner');
});

test('artifact callbacks are synchronous typed capabilities, not replacement snapshots', () => {
  const source = productionSources.get('ports.ts') ?? '';
  assert.match(source, /read<R>\(select: \(facts: SquareRead\) => R,/);
  assert.match(source, /transact<R>\(change: \(facts: SquareWrite\) => R,/);
  assert.doesNotMatch(source, /SquareState|state\?:/);
});

test('pure landing depends only on domain facts and syntax', () => {
  const edges = moduleEdges('square-domain.ts', productionSources.get('square-domain.ts'));
  for (const edge of edges) {
    assert.ok(['./model.js', './ports.js'].includes(edge.module), edge.module);
    if (edge.module === './ports.js') assert.deepEqual(edge.names, []);
  }
});

test('the artifact contract comes from ports.ts alone', () => {
  const storage = productionSources.get('artifact.ts') ?? '';
  assert.match(
    storage,
    /import type \{[^}]*\bSquareArtifactPort\b[^}]*\} from '\.\/ports\.js';/,
    'artifact.ts must implement the declared SquareArtifactPort',
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
  const directClose = filesContaining(/\bartifact\.close\s*\(/, ['open-square.ts', 'inbox.ts', 'ledger-maintenance.ts']);
  assert.deepEqual(directClose, [], `artifact close escaped its package-private boundary: ${directClose.join(', ')}`);
  // The real Square resource is the only entry into participant execution.
  const actionBypasses = filesContaining(/from ['"](?:\.\/|\.\.\/)square-actions\.js['"]/, ['sqlite-square.ts']);
  assert.deepEqual(actionBypasses, [], `participant mutation bypasses Square/Participant facade: ${actionBypasses.join(', ')}`);
  const presenceBypasses = filesContaining(/from ['"](?:\.\/|\.\.\/)presence\.js['"]/, []);
  assert.deepEqual(presenceBypasses, [], `boundary acknowledgement bypasses facade: ${presenceBypasses.join(', ')}`);
});

function moduleEdges(file, source) {
  const edges = [];
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
      const typeOnly = !!node.isTypeOnly || !!clause?.isTypeOnly;
      const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : clause;
      const elements = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ? bindings.elements : undefined;
      const names = elements
        ? elements.filter((element) => !typeOnly && !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text)
        : typeOnly ? [] : ['*'];
      const types = elements
        ? elements.filter((element) => typeOnly || element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text)
        : typeOnly ? ['*'] : [];
      if (ts.isImportDeclaration(node) && clause?.name) (typeOnly ? types : names).push('default');
      edges.push({ module: node.moduleSpecifier.text, names, types });
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const arg = node.arguments[0];
      edges.push({ module: arg && ts.isStringLiteral(arg) ? arg.text : '<dynamic>', names: ['*'], types: [] });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return edges;
}

// These are edge exceptions, not directories exempt from scrutiny. Native runtime
// entrypoints end this product-operation traversal; no ordinary CLI helper does.
const integrationEdges = new Map([
  ['cli/harness-command.ts -> harness.ts', ['executeHarnessTarget', 'harnessTargets']],
  ['cli/observation-commands.ts -> claude-mod.ts', ['runClaudeMod']],
  ['cli/observation-commands.ts -> codex-hook.ts', ['runCodexHookAsync']],
  ['mcp.ts -> claude-mcp-context.ts', ['readClaudeMcpCall']],
  ['cli/ledger-command.ts -> host-ledger-migration.ts', ['verifyHostLedger', 'migrateHostLedger']],
  ['cli/ledger-command.ts -> ledger-maintenance.ts', ['gcHostLedger']],
]);
const pureBindings = new Map([
  ['square-core.ts', ['formatActivityId', 'parseActivityId', 'MAX_IDENTITY_SET_SIZE']],
  ['runtime.ts', ['HELD_WAIT_BUDGET_MS']],
  ['model.ts', ['SquareError', 'isSquareError', 'sameName', 'nameKey', 'formatHardCap', 'parseParticipantList', 'validateName']],
  ['participant-identity.ts', ['participantIdentity', 'operationEnv']],
  ['search.ts', ['grepSnippet']],
]);
const pureTypeBindings = new Map([
  ['square-core.ts', ['ActivityId', 'Perception', 'Reach']],
  ['model.ts', ['HardCap', 'BuildOptions', 'RoomChangeAct', 'StoredAct', 'PublicAct']],
]);
const integrationTypeBindings = new Map([
  ['cli/harness-command.ts -> harness.ts', ['HarnessAction', 'HarnessTargetResult']],
  ['cli/ledger-command.ts -> host-ledger-migration.ts', ['HostLedgerReport']],
  ['cli/ledger-command.ts -> ledger-maintenance.ts', ['LedgerMaintenanceReport']],
]);
const presentationHelpers = new Set(['presentation.ts', 'time.ts', 'tty-style.ts', 'help.ts', 'identity.ts']);

function transportLeaks(sources, roots) {
  const visited = new Set(), leaks = [];
  function traverse(file, trail) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = sources.get(file);
    if (source === undefined) { leaks.push(`missing helper: ${trail.join(' -> ')}`); return; }
    for (const edge of moduleEdges(file, source)) {
      if (!edge.module.startsWith('.')) {
        if (edge.module === '<dynamic>') leaks.push(`unbounded import: ${trail.join(' -> ')}`);
        continue;
      }
      const target = resolvedTarget(file, edge.module);
      if (target === 'square-api.ts') continue;
      if (target === 'square-facade.ts') {
        if (edge.names.length > 0) leaks.push(`DTO runtime import: ${[...trail, target].join(' -> ')}`);
        continue;
      }
      const exception = integrationEdges.get(`${file} -> ${target}`);
      if (exception !== undefined) {
        const allowedTypes = integrationTypeBindings.get(`${file} -> ${target}`) ?? [];
        if (edge.names.some((name) => !exception.includes(name)) || edge.types.some((name) => !allowedTypes.includes(name))) leaks.push(`integration exception exceeded: ${file} -> ${target} (${[...edge.names, ...edge.types].join(', ')})`);
        continue;
      }
      const pure = pureBindings.get(target);
      if (pure !== undefined) {
        const allowedTypes = pureTypeBindings.get(target) ?? [];
        if (edge.names.some((name) => !pure.includes(name)) || edge.types.some((name) => !allowedTypes.includes(name))) leaks.push(`private binding: ${file} -> ${target} (${[...edge.names, ...edge.types].join(', ')})`);
        // These mixed modules are terminal syntax boundaries, not permission to
        // reach their execution dependencies or import namespaces from them.
        continue;
      }
      if (target.startsWith('cli/') || presentationHelpers.has(target) || ['mcp.ts', 'square-tools.ts'].includes(target)) traverse(target, [...trail, target]);
      else leaks.push(`private execution import: ${[...trail, target].join(' -> ')}`);
    }
  }
  for (const file of roots) traverse(file, [file]);
  return leaks.sort();
}

test('CLI/MCP and every reachable presentation helper use Square/Participant, not private execution', () => {
  const roots = productionFiles.filter((file) => file.startsWith('cli/')).concat(['mcp.ts', 'presentation.ts']);
  const leaks = transportLeaks(productionSources, roots);
  assert.deepEqual(leaks, [], `transport boundary escaped transitively:\n${leaks.join('\n')}`);
});

test('transport boundary catches hidden execution behind helpers and limits native and syntax exceptions', () => {
  assert.deepEqual(transportLeaks(new Map([
    ['presentation.ts', "import { formatActivityId, MAX_IDENTITY_SET_SIZE, type Perception } from './square-core.js'; import { HELD_WAIT_BUDGET_MS } from './runtime.js';"],
  ]), ['presentation.ts']), []);
  const sources = new Map([
    ['cli/program.ts', "import './nested.js';"],
    ['cli/nested.ts', "import './render.js';"],
    ['cli/render.ts', "export { history } from '../views.js'; export { createArtifactPort } from '../artifact.js';"],
    ['presentation.ts', "import { audienceIncludes } from './square-core.js'; import { nowMs } from './runtime.js';"],
    ['mcp.ts', "import * as identity from './participant-identity.js'; import { beginClaudeMcpCall } from './claude-mcp-context.js'; import './square-tools.js';"],
    ['square-tools.ts', "import { express } from './square-actions.js';"],
  ]);
  assert.deepEqual(transportLeaks(sources, ['cli/program.ts', 'presentation.ts', 'mcp.ts']), [
    'integration exception exceeded: mcp.ts -> claude-mcp-context.ts (beginClaudeMcpCall)',
    'private binding: mcp.ts -> participant-identity.ts (*)',
    'private binding: presentation.ts -> runtime.ts (nowMs)',
    'private binding: presentation.ts -> square-core.ts (audienceIncludes)',
    'private execution import: cli/program.ts -> cli/nested.ts -> cli/render.ts -> artifact.ts',
    'private execution import: cli/program.ts -> cli/nested.ts -> cli/render.ts -> views.ts',
    'private execution import: mcp.ts -> square-tools.ts -> square-actions.ts',
  ]);
});
