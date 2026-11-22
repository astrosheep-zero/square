import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensions = ['.ts', '.tsx', '.js', '.mjs', '.cts', '.mts', '.cjs'];
const compiled = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
const cli = 'cli/';
const pi = 'plugins/pi/';
const delivery = 'packages/agent-delivery/src/';
const bin = 'square.ts';
const facade = 'api/square-facade.ts';
const driver = 'ledger/delivery-ledger-sqlite.ts';
const storageLeaves = ['storage/sqlite-framing.ts', 'storage/sqlite-values.ts', 'storage/sqlite-transaction.ts'];
const sqlite = /^(?:node:|bun:)sqlite$/;
const sql = /^\s*(?:(?:CREATE|DROP|ALTER)\s+TABLE\b|INSERT(?:\s+OR\s+\w+)?\s+INTO\b|SELECT\s+[\s\S]+?\s+FROM\b|UPDATE\s+[\s\S]+?\s+SET\b|DELETE\s+FROM\b|PRAGMA\s+\w|BEGIN\s+(?:EXCLUSIVE|IMMEDIATE)\b)/i;

function productionSources() {
  function collect(dir, recursive) {
    return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const file = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) return recursive && !['dist', 'node_modules', 'test', 'tests'].includes(entry.name) ? collect(file, true) : [];
      return extensions.includes(path.posix.extname(file)) ? [[file, fs.readFileSync(path.join(root, file), 'utf8')]] : [];
    });
  }
  return new Map([...collect('', false), ...[cli, 'core', 'storage', 'artifact', 'ledger', 'app', 'hosts', 'api', 'surfaces', 'plugins', delivery].flatMap((dir) => collect(dir, true))]);
}

// A binding is its source spelling: `Foo`, `type Foo`, or `*`/`type *` for a namespace.
const named = ({ bindings }, allowed = []) => bindings.every((name) => allowed.includes(name));
const isType = (binding) => binding.startsWith('type ');
const typeOnly = ({ bindings }) => bindings.every(isType);
const id = (node, name) => !!node && ts.isIdentifier(node) && node.text === name;
const text = (node) => node && ts.isStringLiteralLike(node) ? node.text : undefined;
const lineOf = (node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
const unwrap = (node) => node && ts.skipOuterExpressions(node);

function clauseBindings(node) {
  const clause = node.importClause ?? node.exportClause;
  const group = clause?.namedBindings ?? node.exportClause;
  const bind = (name, inlineType) => clause?.isTypeOnly || node.isTypeOnly || inlineType ? `type ${name}` : name;
  const defaultBinding = node.importClause?.name ? [bind('default')] : [];
  const names = group?.elements?.map((element) => bind((element.propertyName ?? element.name).text, element.isTypeOnly));
  return defaultBinding.concat(names?.length ? names : group || !defaultBinding.length ? [bind('*')] : []);
}

function moduleBindings(node) {
  if (ts.isImportEqualsDeclaration(node)) return [node.isTypeOnly ? 'type *' : '*'];
  if (!ts.isImportTypeNode(node)) return clauseBindings(node);
  let name = node.qualifier;
  while (name && ts.isQualifiedName(name)) name = name.left;
  return [`type ${name?.text ?? '*'}`];
}

function loadedBindings(call) {
  const declaration = ts.findAncestor(call.parent, (node) => !ts.isParenthesizedExpression(node) && !ts.isAwaitExpression(node));
  const pattern = declaration && ts.isVariableDeclaration(declaration) && declaration.name;
  const elements = pattern && ts.isObjectBindingPattern(pattern) ? pattern.elements : [];
  const flat = elements.length && elements.every(({ dotDotDotToken, name, propertyName }) => !dotDotDotToken && ts.isIdentifier(name) && (!propertyName || ts.isIdentifier(propertyName)));
  return flat ? elements.map(({ name, propertyName }) => (propertyName ?? name).text) : ['*'];
}

function requireScope(identifier) {
  if (!id(identifier, 'require') || identifier.parent.name !== identifier) return;
  const binding = ts.getRootDeclaration(identifier.parent);
  if (ts.isVariableDeclaration(binding) && !ts.isBlockOrCatchScoped(binding))
    return ts.findAncestor(binding.parent, (node) => ts.isSourceFile(node) || ts.isFunctionLike(node) || ts.isModuleBlock(node));
  if (ts.isFunctionExpression(binding) || ts.isClassExpression(binding)) return binding;
  if (ts.isVariableDeclaration(binding) || ts.isParameter(binding) || ts.isFunctionDeclaration(binding) || ts.isClassDeclaration(binding) || ts.isEnumDeclaration(binding))
    return ts.getEnclosingBlockScopeContainer(binding);
}

const member = (node) => ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? text(node.argumentExpression) : undefined;
const access = ts.isAccessExpression;
const isEnv = (node) => member(node) === 'env' && id(unwrap(node.expression), 'process');
const mutators = ['Object.assign', 'Object.defineProperty', 'Object.defineProperties', 'Reflect.set', 'Reflect.defineProperty', 'Reflect.deleteProperty'];
function writesEnv(env) {
  let target = ts.walkUpParenthesizedExpressions(env);
  while (access(target.parent) && target.parent.expression === target) target = ts.walkUpParenthesizedExpressions(target.parent);
  const parent = target.parent;
  if (ts.isAssignmentTarget(target) || ts.isDeleteExpression(parent)) return true;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== target) return false;
  const callee = unwrap(parent.expression);
  return access(callee) && mutators.includes(`${unwrap(callee.expression).text}.${member(callee)}`);
}

function launcherImport(file, arg) {
  // The documented Keiyaku SDK override; no other computed dependency is a closed capability.
  if (file !== 'hosts/keiyaku-delivery.ts' || !arg || !ts.isConditionalExpression(arg) || text(arg.whenTrue) !== '@astrosheep/keiyaku') return false;
  const override = arg.whenFalse;
  return ts.isPropertyAccessExpression(override) && override.name.text === 'href' && ts.isCallExpression(override.expression)
    && id(override.expression.expression, 'pathToFileURL') && override.expression.arguments.length === 1 && id(override.expression.arguments[0], 'override');
}

const envFree = ['index.ts', 'api/square-api.ts', facade, 'core/neutral.ts', 'app/square-service.ts', 'app/square-posting.ts', 'core/decisions.ts', 'core/perceive-decisions.ts', 'core/views.ts', 'core/runtime.ts', 'hosts/notifications.ts'];
const ambient = ['SQUARE_DELIVERY', 'SQUARE_NOW_MS', 'squareClock', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'OPENCODE_SESSION_ID', 'PI_SESSION_ID', 'PASEO_AGENT_ID'];
const readsAmbient = (node) => ambient.includes(ts.isIdentifier(node) ? node.text : text(node))
  || (ts.isQualifiedName(node) && id(node.left, 'NodeJS') && id(node.right, 'ProcessEnv'));

const sqlText = (node) => ts.isTemplateExpression(node) ? [node.head, ...node.templateSpans.map((span) => span.literal)].map((part) => part.text).join('?') : text(node) ?? '';
function scan(file, source, issue) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const constants = new Map(), shadows = new Set(), edges = [];
  const record = (node, specifier, bindings) => edges.push({ from: file, line: lineOf(node), specifier, bindings });
  const report = (code, node, target = file) => issue(code, { from: file, line: lineOf(node), target });
  const calls = [];
  ts.forEachChildRecursively(parsed, (node) => {
    const scope = requireScope(node);
    if (scope) shadows.add(scope);
    if (ts.isVariableDeclaration(node) && node.parent.parent?.parent === parsed && ts.isVarConstLike(node) && ts.isIdentifier(node.name))
      constants.set(node.name.text, text(node.initializer));
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)) {
      const specifier = ts.getExternalModuleName(node);
      if (specifier) record(node, text(specifier), moduleBindings(node));
    }
    if (ts.isImportCall(node) || (ts.isCallExpression(node) && id(unwrap(node.expression), 'require'))) calls.push(node);
    const env = isEnv(node);
    if (env && writesEnv(node)) report('env-write', node, 'process.env');
    if (envFree.includes(file) && (env || readsAmbient(node))) report('ambient-env', node, node.getText());
    if (!sqlOwners.includes(file) && sql.test(sqlText(node))) report('sql-literal', node);
  });
  for (const call of calls) {
    if (!ts.isImportCall(call) && ts.findAncestor(call.parent, (scope) => shadows.has(scope))) continue;
    const arg = unwrap(call.arguments[0]);
    const specifier = ts.isImportCall(call) && launcherImport(file, arg) ? '@astrosheep/keiyaku' : text(arg) ?? constants.get(arg?.text);
    record(call, specifier, loadedBindings(call));
  }
  if (file === driver && runtimeExports(parsed.statements).sort().join() !== Object.values(ledgerCallers).flat().sort().join()) report('driver-exports', parsed);
  if (file === facade) for (const node of parsed.statements) if (!isTypeStatement(node)) report('facade-runtime', node, ts.SyntaxKind[node.kind]);
  return edges;
}

function matchSource(target, sources) {
  const file = path.posix.normalize(target).replace(/^dist\//, '');
  const source = file.replace(/\.d(?=\.[cm]?ts$)/, '');
  const ext = path.posix.extname(source);
  const fallbacks = ext ? (compiled[ext] ?? []).map((suffix) => source.slice(0, -ext.length) + suffix)
    : extensions.flatMap((suffix) => [source + suffix, `${source}/index${suffix}`]);
  return [file, source, ...fallbacks].find((candidate) => sources.has(candidate));
}

const packageTarget = (entry, condition) => typeof entry === 'string' ? entry : entry?.[condition] ?? entry?.default;

function resolve(edge, sources, pkg) {
  const { from, specifier, bindings } = edge;
  if (specifier?.startsWith('.')) return [{ ...edge, target: matchSource(path.posix.join(path.posix.dirname(from), specifier), sources) }];
  if (specifier && (path.posix.isAbsolute(specifier) || specifier.startsWith('file:') || specifier.startsWith('#'))) return [{ ...edge, target: undefined }];
  if (specifier !== pkg.name && !specifier?.startsWith(`${pkg.name}/`)) return [{ ...edge, target: null }];
  const entry = pkg.exports?.[`.${specifier.slice(pkg.name.length)}`];
  const targets = Map.groupBy(bindings, (binding) => {
    const exportPath = packageTarget(entry, isType(binding) ? 'types' : 'default');
    return exportPath && matchSource(exportPath, sources);
  });
  return [...targets].map(([target, bindings]) => ({ ...edge, target, bindings }));
}

const physicalCallers = {
  'artifact/square-store.ts': ['artifact/artifact.ts', 'artifact/migrate.ts'],
  'artifact/square-producer-store.ts': ['artifact/square-store.ts', 'artifact/migrate.ts'],
  'storage/sqlite-framing.ts': ['artifact/artifact.ts', 'artifact/square-store.ts', 'artifact/migrate.ts', driver],
  'storage/sqlite-values.ts': ['storage/sqlite-framing.ts', 'artifact/square-store.ts', 'artifact/square-producer-store.ts', 'artifact/artifact.ts', 'artifact/migrate.ts'],
  'storage/sqlite-transaction.ts': ['artifact/artifact.ts', 'artifact/migrate.ts', driver],
};
const sqlOwners = ['artifact/artifact.ts', 'artifact/migrate.ts', driver, `${delivery}file-lock.ts`, ...Object.keys(physicalCallers)];
const artifactCallers = {
  'app/square-service.ts': ['createArtifactPort', 'createSquare', 'prepareSquareBuild', 'diagnoseSquareFile'],
  'app/list.ts': ['createArtifactPort'],
  'app/inbox.ts': ['createArtifactPort'],
  'app/stream.ts': ['createArtifactPort', 'observeSquareRevision'],
};
const ledgerCallers = { 'ledger/delivery-ledger.ts': ['LedgerStore', 'migrateDeliveryLedger'] };
const ledgerTypes = ['DeliveryAttempt', 'DeliveryCard', 'DeliveryCorrelation', 'DeliveryHandoffRef', 'DeliveryHealth', 'DeliveryOutcome', 'DeliveryReceipt', 'DeliveryRoute', 'DeliverySession', 'PostResult', 'SuppressionResult', 'DeliverySuppression', 'MigrateDeliveryLedgerInput', 'MigrateDeliveryLedgerResult'].map(name => `type ${name}`);
const portOwners = ['artifact/artifact.ts', 'app/square-service.ts', 'app/square-posting.ts', 'app/stream.ts', 'core/wakes.ts'];
const factPorts = ['ActivityFilter', 'ActivityHead', 'ActivityIndex', 'ActivitySearch', 'ArtifactWriteAuthority', 'AttentionFact', 'DirectedFilter', 'DirectedHead', 'FutureAck', 'LandedRecipient', 'NotificationId', 'ParticipantCounts', 'ParticipantFact', 'SeatRef', 'SendInput', 'SendResult', 'SquareHeader', 'SquarePost', 'SquarePostDisposition', 'SquareRead', 'SquareWrite'].map(name => `type ${name}`);
const producerPorts = {
  'core/square-domain.ts': ['type ProducerWrite'],
  'artifact/square-producer-store.ts': ['type ProducerRead', 'type ProducerWrite'],
};
const incomingRules = {
  ...Object.fromEntries(Object.entries(physicalCallers).map(([target, callers]) => [target, ['private-target', ({ from }) => callers.includes(from)]])),
  [bin]: ['entry-import', () => false],
  'cli/help.ts': ['help-owner', ({ from }) => from.startsWith(cli)],
  'app/square-service.ts': ['resource-bypass', (edge) => edge.from === 'api/square-api.ts' || edge.from === facade && typeOnly(edge)],
  'core/ports.ts': ['artifact-port', (edge) => named(edge, [...factPorts,
    ...(portOwners.includes(edge.from) ? ['type SquareArtifactPort'] : producerPorts[edge.from] ?? [])])],
  [facade]: ['runtime-dto', typeOnly],
  'artifact/artifact.ts': ['artifact-capability', (edge) => named(edge, artifactCallers[edge.from])],
  [driver]: ['driver-import', (edge) => Boolean(ledgerCallers[edge.from]) && named(edge, [...ledgerCallers[edge.from], ...ledgerTypes])],
};

const presentation = ['surfaces/presentation.ts', 'surfaces/operation-presentation.ts', 'surfaces/square-tools.ts', 'surfaces/mcp.ts'];
const shared = [...presentation, 'core/time.ts', 'surfaces/tty-style.ts', 'cli/help.ts', 'hosts/identity.ts'];
const syntax = {
  'core/square-core.ts': ['formatActivityId', 'isNarratedActivity', 'parseActivityId', 'MAX_IDENTITY_SET_SIZE', 'type Perception'],
  'core/neutral.ts': ['SquareError', 'truncateChars'],
  'core/model.ts': ['SquareError', 'isSquareError', 'sameName', 'formatHardCap', 'parseParticipantList', 'validateName', 'type HardCap', 'type BuildOptions', 'type WakeAddress'],
  'core/square-values.ts': ['participantIdentity'],
  'hosts/codex-address.ts': ['codexWakeAddress'],
  'core/search.ts': ['grepSnippet'],
};
const native = {
  'cli/harness-command.ts -> hosts/harness.ts': ['executeHarnessTarget', 'harnessTargets', 'type HarnessAction', 'type HarnessTargetResult'],
  'cli/observation-commands.ts -> hosts/claude-mod.ts': ['runClaudeMod'],
  'cli/observation-commands.ts -> hosts/codex-hook.ts': ['runCodexHook', 'runCodexInterrupt'],
  'cli/observation-commands.ts -> hosts/codex-watch.ts': ['runCodexWatch'],
  'surfaces/mcp.ts -> hosts/claude-mcp-context.ts': ['readClaudeMcpCall'],
  'cli/context.ts -> hosts/participant-identity.ts': ['akumaActorFromEnvironment', 'harnessSessionSources', 'resolveParticipantIdentity'],
  'cli/mcp-server-command.ts -> hosts/participant-identity.ts': ['akumaActorFromEnvironment'],
  'surfaces/mcp.ts -> hosts/participant-identity.ts': ['resolveParticipantIdentity', 'type AkumaActor'],
  'surfaces/presentation.ts -> hosts/boundary-presentation.ts': ['truncateExternalDiagnostic'],
  'hosts/harness.ts -> hosts/boundary-presentation.ts': ['truncateExternalDiagnostic'],
  'hosts/harness-links.ts -> hosts/boundary-presentation.ts': ['truncateExternalDiagnostic'],
};
const piNative = {
  'plugins/paseo/shared/card-format.ts': ['activityLabel', 'isDirectCardReach', 'shortOrigin', 'timeLabel'],
  'plugins/paseo/shared/card-presentation.ts': ['isCardPresentation', 'type CardPresentation'],
  'core/owner.ts': ['harnessOwner'],
  'hosts/participant-identity.ts': ['requestPiAkumaActor', 'resolveParticipantIdentity'],
  'ledger/delivery-ledger.ts': ['DeliveryLedger'],
  'hosts/boundary-presentation.ts': ['deliveryFrameOverhead', 'renderDeliveryReminder'],
  'ledger/session-lifecycle.ts': ['attachDeliverySessionRoutes', 'detachDeliverySession'],
  [`${delivery}pi.ts`]: ['createPiReceiver', 'sendPiMessage'],
};

// Closure policies return FOLLOW for another helper, an issue code for an escape, or nothing for a closed capability.
const FOLLOW = Symbol('follow dependency');
const piRaw = /^(?:node:)?fs(?:\/promises)?$|^(?:node:|bun:)sqlite$/;
function adapter(edge, isPi) {
  const { from, target, specifier } = edge;
  if (!target) return isPi && piRaw.test(specifier) ? 'pi-raw' : undefined;
  if (target === 'api/square-api.ts' || target === (isPi ? 'surfaces/square-tools.ts' : facade)) return;
  if (isPi ? target.startsWith(pi) : target.startsWith(cli) || shared.includes(target)) return FOLLOW;
  const allowed = isPi ? piNative[target] : native[`${from} -> ${target}`] ?? syntax[target];
  return allowed ? (named(edge, allowed) ? undefined : 'adapter-binding') : 'adapter-private';
}

const domain = ['core/square-domain.ts', 'core/decisions.ts', 'core/perceive-decisions.ts', 'core/views.ts'];
const factInputs = ['core/model.ts', 'core/message.ts', 'core/attention.ts', 'core/ports.ts', 'core/neutral.ts', 'core/runtime.ts', 'core/square-core.ts', 'core/square-values.ts', 'core/mention-parse.ts', 'core/decisions.ts', 'core/views.ts', 'core/hints.ts', 'core/receive.ts', 'core/activity-query.ts'];
const outsideDomain = (edge) => domain.includes(edge.from) && !factInputs.includes(edge.target);

const isTypeStatement = (node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
  || ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) && typeOnly({ bindings: moduleBindings(node) }));
function runtimeExports(statements) {
  return statements.flatMap((node) => {
    if (isTypeStatement(node)) return [];
    if (ts.isExportDeclaration(node))
      return node.exportClause?.elements?.filter((element) => !element.isTypeOnly).map((element) => element.name.text) ?? ['*'];
    const flags = ts.getCombinedModifierFlags(node);
    if (ts.isExportAssignment(node) || flags & ts.ModifierFlags.Default) return ['default'];
    if (!(flags & ts.ModifierFlags.Export) || flags & ts.ModifierFlags.Ambient) return [];
    return ts.isVariableStatement(node) ? node.declarationList.declarations.map(({ name }) => name.getText()) : [node.name?.text ?? '*'];
  });
}

function violations(sources, pkg = manifest) {
  const found = [];
  function issue(code, { from, target, specifier, line, bindings }, trail) {
    found.push({ code, from, target: target ?? specifier ?? '<computed>', line, symbols: bindings, trail });
  }
  const edges = [...sources].flatMap(([file, source]) => scan(file, source, issue).flatMap((edge) => resolve(edge, sources, pkg)));
  const outgoing = Map.groupBy(edges, (edge) => edge.from);
  const incoming = Map.groupBy(edges, (edge) => edge.target);
  for (const edge of edges) {
    const { from, target, specifier } = edge;
    if (target === undefined) issue('unresolved-import', edge);
    if (specifier === undefined) issue('dynamic-import', edge);
    if (sqlite.test(specifier) && !sqlOwners.includes(from)) issue('raw-sqlite', edge);
    if (target?.startsWith(cli) && ![bin, 'cli/help.ts'].includes(from) && !from.startsWith(cli)) issue('cli-import', edge);
    if (target && from.startsWith(delivery) && !target.startsWith(delivery)) issue('delivery-outbound', edge);
    if (['core/receive.ts', 'core/attention.ts'].includes(from)) issue('leaf-import', edge);
    if (outsideDomain(edge)) issue('domain-direction', edge);
  }
  for (const [target, [code, allowed]] of Object.entries(incomingRules))
    for (const edge of incoming.get(target) ?? []) if (!allowed(edge)) issue(code, edge);
  const [first, second] = outgoing.get(bin) ?? [];
  if (second || first?.target !== 'cli/program.ts' || first.bindings.join() !== 'runCli') issue('entry-shape', first ?? { from: bin });
  if (path.posix.normalize(pkg.bin?.square ?? '') !== 'dist/square.js') issue('package-bin', { from: 'package.json', target: pkg.bin?.square });
  for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) for (const exportPath of new Set([packageTarget(entry, 'default'), packageTarget(entry, 'types')])) {
    if (!exportPath) continue;
    const target = matchSource(exportPath, sources);
    if (!target) issue('package-target', { from: subpath, target: exportPath });
    else if ([bin, ...sqlOwners, 'app/square-service.ts', 'core/ports.ts'].includes(target)) issue('package-alias', { from: subpath, target });
  }

  function closure(roots, policy) {
    const paths = new Map(roots.map((file) => [file, [file]]));
    for (const [file, trail] of paths) for (const edge of outgoing.get(file) ?? []) {
      const decision = policy(edge);
      if (decision === FOLLOW && !paths.has(edge.target)) paths.set(edge.target, [...trail, edge.target]);
      else if (decision && decision !== FOLLOW) issue(decision, edge, trail);
    }
  }
  const sdkRoots = ['api/square-api.ts', 'index.ts', ...['default', 'types'].map((kind) => packageTarget(pkg.exports?.['.'], kind)).filter(Boolean).map((target) => matchSource(target, sources))];
  closure(sdkRoots, ({ target }) => {
    if (!target) return;
    return target.startsWith(cli) || [...presentation, 'cli/help.ts', 'surfaces/tty-style.ts'].includes(target) ? 'sdk-direction' : FOLLOW;
  });
  closure(storageLeaves, ({ target, specifier }) => {
    if (target) return [...storageLeaves, 'core/neutral.ts'].includes(target) ? FOLLOW : 'neutral-edge';
    if (!specifier?.startsWith('node:')) return 'neutral-edge';
  });
  closure([bin, ...presentation, ...[...sources.keys()].filter((file) => file.startsWith(cli))], (edge) => adapter(edge, false));
  closure([`${pi}square-pi.js`], (edge) => adapter(edge, true));
  return found;
}

const keys = (issues) => issues.map(({ code, from, target }) => `${code}:${from}->${target}`);

test('production dependencies stay inside their storage, entry, adapter, domain and environment boundaries', () => {
  assert.deepEqual(violations(productionSources()), []);
});

test('the same graph rejects resolved escapes and admits named capabilities', () => {
  const pkg = {
    name: '@sample/square',
    bin: { square: './dist/square.js' },
    exports: { '.': { types: './dist/api/square-facade.d.ts', default: './dist/index.js' }, './bin': './dist/square.js' },
  };
  const stubs = ['cli/program.ts', 'core/square-core.ts', 'hosts/harness.ts', 'core/model.ts', 'core/owner.ts', 'app/square-service.ts', 'core/ports.ts'];
  const samples = {
    'square.ts': "import { runCli } from './cli/program.js';",
    'index.ts': "export * from './sdk-helper.js';",
    'sdk-helper.ts': `import { DatabaseSync } from 'node:sqlite';
      const bun = 'bun:sqlite'; await import(bun);
      const query = 'INSERT OR REPLACE INTO activities VALUES (1)';
      import '@sample/square/bin';`,
    'surfaces/presentation.ts': "import { formatActivityId, type Perception } from '../core/square-core.js'; import type { Dto } from '@sample/square';",
    'api/square-facade.ts': "export type { SquareArtifactPort as Dto } from '../core/ports.js';",
    'cli/harness-command.ts': "import { executeHarnessTarget, type HarnessAction } from '../hosts/harness.js'; import * as native from '../hosts/harness.js';",
    'storage/sqlite-framing.ts': "import type { X } from '../core/neutral.js';",
    'core/neutral.ts': "export type X = import('./model.js').X;",
    'plugins/pi/square-pi.js': "import { helper } from '../../dist/plugins/pi/helper.js'; import { harnessOwner } from '../../dist/core/owner.js';",
    'plugins/pi/helper.ts': "import 'fs'; export const helper = () => import('../../dist/app/square-service.js');",
    'core/decisions.ts': "import type { SquareArtifactPort as Handle, SquareRead } from './ports.js';",
    'core/perceive-decisions.ts': "import type * as Ports from './ports.js'; type Handle = Ports.SquareArtifactPort;",
    'core/views.ts': "type Ports = typeof import('./ports.js'); type Handle = import('./ports.js').SquareArtifactPort;",
    'core/square-domain.ts': "import type { SquareRead } from './ports.js'; type Head = import('./ports.js').ActivityHead;",
    'env-writer.ts': "process['env'][id] += 'x'; Reflect['set'](process.env, id, 'x');",
    'ledger/delivery-ledger-sqlite.ts': 'export class LedgerStore {} export function migrateDeliveryLedger() {}',
    'plugins/opencode/index.ts': "const { DatabaseSync: Raw } = await import('../../dist/ledger/delivery-ledger-sqlite.js');",
    'shadowed.ts': "export function migrate() { return require('./not-a-module.js'); function require(value) { return value; } }",
    'hosts/keiyaku-delivery.ts': "await import(flag ? '@astrosheep/keiyaku' : '../artifact/square-store.js');",
  };
  const issues = violations(new Map([...stubs.map((file) => [file, '']), ...Object.entries(samples)]), pkg);
  assert.deepEqual(keys(issues).sort(), [
    'raw-sqlite:sdk-helper.ts->node:sqlite', 'raw-sqlite:sdk-helper.ts->bun:sqlite', 'sql-literal:sdk-helper.ts->sdk-helper.ts',
    'entry-import:sdk-helper.ts->square.ts', 'package-alias:./bin->square.ts', 'sdk-direction:square.ts->cli/program.ts',
    'neutral-edge:core/neutral.ts->core/model.ts', 'pi-raw:plugins/pi/helper.ts->fs', 'adapter-private:plugins/pi/helper.ts->app/square-service.ts',
    'resource-bypass:plugins/pi/helper.ts->app/square-service.ts', 'driver-import:plugins/opencode/index.ts->ledger/delivery-ledger-sqlite.ts',
    'artifact-port:core/decisions.ts->core/ports.ts', 'artifact-port:core/perceive-decisions.ts->core/ports.ts', 'artifact-port:core/views.ts->core/ports.ts',
    'artifact-port:core/views.ts->core/ports.ts', 'artifact-port:api/square-facade.ts->core/ports.ts', 'adapter-binding:cli/harness-command.ts->hosts/harness.ts',
    'env-write:env-writer.ts->process.env', 'env-write:env-writer.ts->process.env', 'dynamic-import:hosts/keiyaku-delivery.ts-><computed>',
  ].sort());
  const hidden = issues.find(({ code }) => code === 'adapter-private');
  assert.deepEqual(hidden.trail, ['plugins/pi/square-pi.js', 'plugins/pi/helper.ts']);
  assert.deepEqual([hidden.line, hidden.symbols], [1, ['*']]);
});
