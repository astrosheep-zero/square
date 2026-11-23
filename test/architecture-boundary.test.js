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
const [agentDelivery, slackBridge] = ['packages/agent-delivery', 'packages/slack-bridge'].map((dir) => ({ dir, pkg: JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')) }));
const allowed = {
  core: ['core'], storage: ['core', 'storage'], artifact: ['core', 'storage', 'artifact'],
  ledger: ['core', 'storage', 'ledger'],
  app: ['core', 'storage', 'artifact', 'ledger', 'app', 'paseo-shared'],
  hosts: ['core', 'storage', 'ledger', 'hosts', 'paseo-shared', 'agent-delivery'],
  api: ['core', 'storage', 'artifact', 'ledger', 'app', 'hosts', 'api', 'paseo-shared'],
  surfaces: ['core', 'storage', 'artifact', 'ledger', 'app', 'hosts', 'api', 'surfaces', 'paseo-shared'],
  cli: ['core', 'storage', 'artifact', 'ledger', 'app', 'hosts', 'api', 'surfaces', 'cli', 'paseo-shared'],
  entry: ['*'], 'agent-delivery': ['agent-delivery'], 'paseo-shared': ['paseo-shared'],
  'paseo-plugin': ['paseo-plugin', 'paseo-shared'],
  'square-plugin': ['core', 'storage', 'ledger', 'hosts', 'api', 'surfaces', 'square-plugin', 'paseo-shared', 'agent-delivery'],
  'slack-consumer': ['slack-consumer', 'entry'], 'example-consumer': ['example-consumer', 'entry', 'ledger'],
  'build-tooling': ['build-tooling'],
};
const [sdkEntry, paseoEntry, cliEntry] = ['index.ts', 'paseo.ts', 'square.ts'];
const entryFiles = new Set([sdkEntry, paseoEntry, cliEntry]);
const ledgerDriver = 'ledger/delivery-ledger-sqlite.ts';
const sqliteOwners = new Set([ledgerDriver, 'packages/agent-delivery/src/file-lock.ts']);
const artifactOwner = 'artifact/artifact.ts', artifactPort = 'core/ports.ts';
const privateApp = new Set(['app/square.ts', 'app/participant.ts']);
const operationTable = 'surfaces/operations.ts';
const sharedInput = ({ from, target, typeOnly, names }) => target === operationTable && (
  (typeOnly && ['core/observations.ts', 'core/perceive-decisions.ts', 'api/types.ts'].includes(from)) ||
  (['api/square-api.ts', 'app/list.ts'].includes(from) || privateApp.has(from)) && names.every(name => name === 'parseOperation' || typeOnly)
);
const artifactPortOwners = new Set([artifactOwner, ...privateApp, 'app/square-posting.ts', 'app/stream.ts', 'core/wakes.ts']);
const deliverySuggestion = ({ from, target, names }) => target === operationTable
  && ['app/square-posting.ts', 'hosts/keiyaku-delivery.ts'].includes(from) && names.join() === 'spellAction';
function layer(file) {
  if (entryFiles.has(file)) return 'entry';
  if (file.startsWith('plugins/paseo/shared/')) return 'paseo-shared';
  if (file.startsWith('plugins/paseo/')) return 'paseo-plugin';
  if (file.startsWith('plugins/')) return 'square-plugin';
  if (file.startsWith('packages/agent-delivery/src/')) return 'agent-delivery';
  if (file.startsWith('packages/slack-bridge/src/')) return 'slack-consumer';
  if (file.startsWith('examples/')) return 'example-consumer';
  if (file.startsWith('scripts/')) return 'build-tooling';
  const dir = file.split('/')[0];
  return ['core', 'storage', 'artifact', 'ledger', 'app', 'hosts', 'api', 'surfaces', 'cli'].includes(dir) ? dir : undefined;
}
function collectSources(dir = '') {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return ['.git', '.keiyaku', '.agents', 'node_modules', 'dist', 'test', 'tests', 'guides', 'skills'].includes(entry.name) || entry.name.startsWith('.') ? [] : collectSources(file);
    return extensions.includes(path.posix.extname(file)) ? [[file, fs.readFileSync(path.join(root, file), 'utf8')]] : [];
  });
}
const id = (node, name) => !!node && ts.isIdentifier(node) && node.text === name;
const text = (node) => node && ts.isStringLiteralLike(node) ? node.text : undefined;
const unwrap = (node) => node && ts.skipOuterExpressions(node);
const member = (node) => ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? text(node.argumentExpression) : undefined;
const isEnv = (node) => ts.isAccessExpression(node) && member(node) === 'env' && id(unwrap(node.expression), 'process');
function writesEnv(env) {
  let target = ts.walkUpParenthesizedExpressions(env);
  while (ts.isAccessExpression(target.parent) && target.parent.expression === target) target = ts.walkUpParenthesizedExpressions(target.parent);
  const parent = target.parent;
  if (ts.isAssignmentTarget(target) || ts.isDeleteExpression(parent)) return true;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== target) return false;
  const callee = unwrap(parent.expression);
  return ts.isAccessExpression(callee) && ['Object.assign', 'Object.defineProperty', 'Object.defineProperties', 'Reflect.set', 'Reflect.defineProperty', 'Reflect.deleteProperty'].includes(`${unwrap(callee.expression).text}.${member(callee)}`);
}
function requireScope(identifier) {
  if (!id(identifier, 'require') || identifier.parent.name !== identifier) return;
  const binding = ts.getRootDeclaration(identifier.parent);
  if (ts.isVariableDeclaration(binding) && !ts.isBlockOrCatchScoped(binding)) return ts.findAncestor(binding.parent, (node) => ts.isSourceFile(node) || ts.isFunctionLike(node) || ts.isModuleBlock(node));
  if (ts.isFunctionExpression(binding) || ts.isClassExpression(binding)) return binding;
  if (ts.isVariableDeclaration(binding) || ts.isParameter(binding) || ts.isFunctionDeclaration(binding) || ts.isClassDeclaration(binding) || ts.isEnumDeclaration(binding)) return ts.getEnclosingBlockScopeContainer(binding);
}
const sql = /^\s*(?:(?:CREATE|DROP|ALTER)\s+TABLE\b|INSERT(?:\s+OR\s+\w+)?\s+INTO\b|SELECT\s+[\s\S]+?\s+FROM\b|UPDATE\s+[\s\S]+?\s+SET\b|DELETE\s+FROM\b|PRAGMA\s+\w|BEGIN\s+(?:EXCLUSIVE|IMMEDIATE)\b)/i;
const sqlite = /^(?:node:|bun:)sqlite$/;
const sqlOwner = (file) => ['storage', 'artifact'].includes(layer(file)) || sqliteOwners.has(file);
const ambient = /^(?:SQUARE_DELIVERY|SQUARE_NOW_MS|squareClock|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID|OPENCODE_SESSION_ID|PI_SESSION_ID|PASEO_AGENT_ID)$/;
function scan(file, source, issue) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edges = [], calls = [], shadows = new Set(), constants = new Map();
  const report = (code, node, target = file) => issue(code, { from: file, target, line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  const record = (node, specifier, names = ['*'], typeOnly = false) => edges.push({ from: file, specifier, names, typeOnly, explicit: ts.isImportDeclaration(node) && !!node.importClause?.namedBindings?.elements, line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  ts.forEachChildRecursively(parsed, (node) => {
    const scope = requireScope(node); if (scope) shadows.add(scope);
    if (ts.isVariableDeclaration(node) && node.parent.parent?.parent === parsed && ts.isVarConstLike(node) && ts.isIdentifier(node.name)) constants.set(node.name.text, text(node.initializer));
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)) {
      const specifier = ts.getExternalModuleName(node);
      if (specifier) {
        const group = node.importClause?.namedBindings ?? node.exportClause;
        const elements = group?.elements;
        const isType = ts.isImportTypeNode(node) || !!node.isTypeOnly || !!node.importClause?.isTypeOnly;
        if (elements && !isType) {
          const types = elements.filter((item) => item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text);
          const values = elements.filter((item) => !item.isTypeOnly).map((item) => (item.propertyName ?? item.name).text);
          if (node.importClause?.name) values.unshift('default');
          if (types.length) record(node, text(specifier), types, true);
          if (values.length || !elements.length) record(node, text(specifier), values);
        } else if (ts.isImportTypeNode(node)) {
          record(node, text(specifier), [node.qualifier?.getText().split('.')[0] ?? '*'], isType);
        } else {
          const defaultName = node.importClause?.name ? ['default'] : [];
          const names = elements?.map((item) => (item.propertyName ?? item.name).text) ?? (group || !defaultName.length ? ['*'] : []);
          record(node, text(specifier), [...defaultName, ...names], isType);
        }
      }
    }
    if (ts.isImportCall(node) || (ts.isCallExpression(node) && id(unwrap(node.expression), 'require'))) calls.push(node);
    const env = isEnv(node);
    if (env && writesEnv(node)) report('env-write', node, 'process.env');
    const protectedLayer = ['core', 'app', 'api'].includes(layer(file)) || [sdkEntry, 'hosts/notifications.ts'].includes(file);
    const redactionDefault = file === 'core/diagnostic-redaction.ts' && ts.findAncestor(node, (parent) => ts.isParameter(parent) && parent.getText() === 'env: NodeJS.ProcessEnv = process.env');
    if (protectedLayer && !redactionDefault && (env || ambient.test(ts.isIdentifier(node) ? node.text : text(node) ?? '') || (ts.isQualifiedName(node) && id(node.left, 'NodeJS') && id(node.right, 'ProcessEnv')))) report('ambient-env', node);
    const sqlText = ts.isTemplateExpression(node) ? [node.head, ...node.templateSpans.map((span) => span.literal)].map((part) => part.text).join('?') : text(node) ?? '';
    if (!sqlOwner(file) && sql.test(sqlText)) report('sql-literal', node);
  });
  for (const call of calls) {
    if (!ts.isImportCall(call) && ts.findAncestor(call.parent, (scope) => shadows.has(scope))) continue;
    const arg = unwrap(call.arguments[0]);
    const launcher = ts.isImportCall(call) && file === 'hosts/keiyaku-delivery.ts' && arg && ts.isConditionalExpression(arg) && text(arg.whenTrue) === '@astrosheep/keiyaku' && arg.whenFalse.getText() === 'pathToFileURL(override).href';
    record(call, launcher ? '@astrosheep/keiyaku' : text(arg) ?? constants.get(arg?.text));
  }
  if (file === 'api/types.ts') for (const node of parsed.statements) {
    const typeStatement = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) && (node.isTypeOnly || node.importClause?.isTypeOnly || (!node.importClause?.name && (node.importClause?.namedBindings ?? node.exportClause)?.elements?.every((item) => item.isTypeOnly))));
    if (!typeStatement) report('types-runtime', node);
  }
  return edges;
}
function matchSource(target, sources) {
  const file = path.posix.normalize(target).replace(/^dist\//, '');
  const source = file.replace(/\.d(?=\.[cm]?ts$)/, ''), ext = path.posix.extname(source);
  const fallbacks = ext ? (compiled[ext] ?? []).map((suffix) => source.slice(0, -ext.length) + suffix) : extensions.flatMap((suffix) => [source + suffix, `${source}/index${suffix}`]);
  return [file, source, ...fallbacks].find((candidate) => sources.has(candidate));
}
const packageTarget = (entry, condition) => typeof entry === 'string' ? entry : entry?.[condition] ?? entry?.import ?? entry?.default;
function resolve(edge, sources, pkg) {
  const { from, specifier } = edge;
  if (specifier?.startsWith('.')) return matchSource(path.posix.join(path.posix.dirname(from), specifier), sources);
  if (specifier && (path.posix.isAbsolute(specifier) || specifier.startsWith('file:') || specifier.startsWith('#'))) return undefined;
  const workspace = [{ dir: '', pkg }, agentDelivery, slackBridge].find(({ pkg: candidate }) => specifier === candidate.name || specifier?.startsWith(`${candidate.name}/`));
  if (!workspace) return specifier === undefined ? undefined : null;
  const target = packageTarget(workspace.pkg.exports?.[`.${specifier.slice(workspace.pkg.name.length)}`], edge.typeOnly ? 'types' : 'default');
  if (!target) return undefined;
  return matchSource(workspace.dir ? path.posix.join(workspace.dir, target.replace(/^\.\/dist\//, 'src/')) : target, sources);
}
function violations(sources, pkg = manifest) {
  const found = [], edges = [];
  const issue = (code, edge) => found.push({ code, ...edge });
  for (const [file, source] of sources) {
    if (!layer(file)) issue('unclassified', { from: file });
    for (const edge of scan(file, source, issue)) edges.push({ ...edge, target: resolve(edge, sources, pkg) });
  }
  const outgoing = Map.groupBy(edges, (edge) => edge.from);
  for (const edge of edges) {
    const { from, target, specifier, names } = edge, origin = layer(from), destination = layer(target ?? '');
    if (specifier === undefined) issue('dynamic-import', edge);
    if (target === undefined) issue('unresolved-import', edge);
    if (target && origin && destination && !sharedInput(edge) && !deliverySuggestion(edge) && ((!allowed[origin].includes('*') && !allowed[origin].includes(destination)) || (origin === 'entry' && destination === 'paseo-plugin'))) issue('layer-direction', edge);
    if (['core/receive.ts', 'core/attention.ts'].includes(from)) issue('leaf-import', edge);
    if (sqlite.test(specifier) && !sqlOwner(from)) issue('raw-sqlite', edge);
    if (origin === 'square-plugin' && from.startsWith('plugins/pi/') && /^(?:node:)?fs(?:\/promises)?$|^(?:node:|bun:)sqlite$/.test(specifier)) issue('pi-raw', edge);
    if (target === artifactPort && (!edge.typeOnly || names.includes('*') || (names.includes('SquareArtifactPort') && (!edge.explicit || !artifactPortOwners.has(from))))) issue('artifact-port', edge);
    if (from === 'core/neutral.ts' && target?.startsWith('core/')) issue('neutral-edge', edge);
    if (origin === 'storage' && destination === 'core' && target !== 'core/neutral.ts') issue('neutral-edge', edge);
    if (from.startsWith('cli/') && destination === 'hosts' && names.includes('*')) issue('host-namespace', edge);
    if (target === ledgerDriver && origin !== 'ledger') issue('driver-private', edge);
    if (privateApp.has(target) && !['app', 'api'].includes(origin)) issue('app-private', edge);
    if (target === artifactOwner && !['artifact', 'app'].includes(origin)) issue('artifact-private', edge);
    if (!['agent-delivery', 'slack-consumer', 'example-consumer', 'build-tooling'].includes(origin) && (specifier === agentDelivery.pkg.name || specifier?.startsWith(`${agentDelivery.pkg.name}/`))) issue('agent-delivery-package', edge);
    if (target === cliEntry) issue('entry-import', edge);
  }
  const sdk = new Set([sdkEntry, 'api/square-api.ts', ...['default', 'types'].map((kind) => packageTarget(pkg.exports?.['.'], kind)).filter(Boolean).map((target) => matchSource(target, sources)).filter(Boolean)]);
  for (const file of sdk) for (const edge of outgoing.get(file) ?? []) if (edge.target) {
    if (sharedInput(edge) || deliverySuggestion(edge)) {
      sdk.add(edge.target);
      continue;
    }
    if (['cli', 'surfaces'].includes(layer(edge.target)) || edge.target === cliEntry) issue('sdk-direction', edge);
    else sdk.add(edge.target);
  }
  const visits = new Map();
  function visit(file) {
    if (visits.get(file) === 'active') { issue('cycle', { from: file }); return; }
    if (visits.has(file)) return;
    visits.set(file, 'active');
    for (const edge of outgoing.get(file) ?? []) if (edge.target && !(file === operationTable && edge.typeOnly)) visit(edge.target);
    visits.set(file, 'done');
  }
  for (const file of sources.keys()) visit(file);
  const bin = outgoing.get(cliEntry) ?? [];
  if (bin.length !== 1 || bin[0].typeOnly || bin[0].target !== 'cli/program.ts' || bin[0].names.join() !== 'runCli') issue('entry-shape', { from: cliEntry });
  if (path.posix.normalize(pkg.bin?.square ?? '') !== 'dist/square.js') issue('package-bin', { from: 'package.json' });
  for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) for (const exportPath of new Set([packageTarget(entry, 'default'), packageTarget(entry, 'types')])) {
    if (!exportPath) continue;
    const target = matchSource(exportPath, sources);
    if (!target) issue('package-target', { from: subpath, target: exportPath });
    else if (target === cliEntry || sqlOwner(target) || privateApp.has(target) || target === artifactPort) issue('package-alias', { from: subpath, target });
  }
  return found;
}

test('production graph respects directory ownership', () => {
  assert.deepEqual(violations(new Map(collectSources())), []);
});

test('new files are classified, dependencies resolved, and capabilities fenced', () => {
  const sources = new Map(['cli/program.ts', 'cli/help.ts', 'app/square.ts', 'api/square-api.ts', 'core/model.ts', 'core/ports.ts', 'ledger/delivery-ledger.ts', 'ledger/delivery-ledger-sqlite.ts', 'artifact/artifact.ts', 'hosts/harness.ts', 'plugins/paseo/client/grain.ts', 'packages/agent-delivery/src/index.ts', 'index.ts'].map((file) => [file, '']));
  sources.set('square.ts', "import { runCli } from './cli/program.js';");
  const fixturePkg = { name: manifest.name, bin: { square: './dist/square.js' }, exports: { '.': './dist/index.js' } };
  const check = (files, code, target, pkg = fixturePkg, from = Object.keys(files)[0]) => {
    const issues = violations(new Map([...sources, ...Object.entries(files)]), pkg);
    assert.ok(issues.some((issue) => issue.code === code && issue.from === from && (issue.target ?? issue.specifier) === target), `${code}: ${JSON.stringify(issues)}`);
  };
  const pass = (files) => assert.deepEqual(violations(new Map([...sources, ...Object.entries(files)]), fixturePkg), []);
  pass({ 'hosts/new.ts': "import '../ledger/delivery-ledger.js';", 'surfaces/new.ts': "import '../api/square-api.js';" });
  for (const source of ["import '../app/square.js';", "export * from '../app/square.js';", "import('../app/square.js');", "require('../app/square.js');"]) check({ 'core/new.ts': source }, 'layer-direction', 'app/square.ts');
  check({ 'artifact/new.ts': "import '../ledger/delivery-ledger.js';" }, 'layer-direction', 'ledger/delivery-ledger.ts');
  check({ 'app/new.ts': "import 'node:sqlite';" }, 'raw-sqlite', 'node:sqlite');
  check({ 'core/new.ts': "import type { B } from './other.js'; export type A = B;", 'core/other.ts': "import type { A } from './new.js'; export type B = A;" }, 'cycle', undefined);
  check({ 'unknown/new.ts': '' }, 'unclassified', undefined);
  check({ 'core/new.ts': "import './missing.js';" }, 'unresolved-import', './missing.js');
  check({ 'core/new.ts': 'import(variable);' }, 'dynamic-import', undefined);
  check({ 'app/new.ts': "const q = 'SELECT * FROM activities';" }, 'sql-literal', 'app/new.ts');
  check({ 'core/new.ts': 'process.env.PI_SESSION_ID; process.env.x = 1;' }, 'ambient-env', 'core/new.ts');
  check({ 'core/new.ts': 'process.env.x = 1;' }, 'env-write', 'process.env');
  for (const source of ["import type { SquareArtifactPort as X } from './ports.js';", "import type * as X from './ports.js';", "type X = typeof import('./ports.js');", "type X = import('./ports.js').SquareArtifactPort;"]) check({ 'core/new.ts': source }, 'artifact-port', 'core/ports.ts');
  check({ 'app/new.ts': "import type { SquareArtifactPort } from '../core/ports.js'; export type { SquareArtifactPort };" }, 'artifact-port', 'core/ports.ts');
  check({ 'artifact/new.ts': "import type { SquareArtifactPort } from '../core/ports.js';" }, 'artifact-port', 'core/ports.ts');
  pass({ 'app/new.ts': "import type { SquareRead } from '../core/ports.js'; export type { SquareRead };" });
  for (const file of ['app/square-posting.ts', 'artifact/artifact.ts', 'core/wakes.ts']) {
    const specifier = file.startsWith('core/') ? './ports.js' : '../core/ports.js';
    for (const source of [`import * as Ports from '${specifier}';`, `import type * as Ports from '${specifier}';`, `export * from '${specifier}';`, `export type { SquareArtifactPort } from '${specifier}';`, `import { SquareArtifactPort } from '${specifier}';`, `type P = import('${specifier}').SquareArtifactPort;`]) check({ [file]: source }, 'artifact-port', 'core/ports.ts');
    pass({ [file]: `import type { SquareArtifactPort, SquareRead } from '${specifier}'; export type { SquareRead } from '${specifier}';` });
  }
  check({ 'core/neutral.ts': "export type X = import('./model.js').X;" }, 'neutral-edge', 'core/model.ts');
  check({ 'storage/new.ts': "import '../core/model.js';" }, 'neutral-edge', 'core/model.ts');
  check({ 'cli/new.ts': "import * as host from '../hosts/harness.js';" }, 'host-namespace', 'hosts/harness.ts');
  check({ 'plugins/pi/new.ts': "import 'fs';" }, 'pi-raw', 'fs');
  check({ 'plugins/pi/new.ts': "import '../../app/square.js';" }, 'layer-direction', 'app/square.ts');
  for (const file of ['plugins/opencode/new.ts', 'plugins/pi/helper.ts']) check({ [file]: "import '../../ledger/delivery-ledger-sqlite.js';" }, 'driver-private', 'ledger/delivery-ledger-sqlite.ts');
  check({ 'packages/agent-delivery/src/new.ts': "import '../../../core/model.js';" }, 'layer-direction', 'core/model.ts');
  check({ 'plugins/paseo/shared/new.ts': "import '../../../core/model.js';" }, 'layer-direction', 'core/model.ts');
  for (const file of ['index.ts', 'paseo.ts']) check({ [file]: "import './plugins/paseo/client/grain.js';" }, 'layer-direction', 'plugins/paseo/client/grain.ts');
  check({ 'index.ts': "import './cli/help.js';" }, 'sdk-direction', 'cli/help.ts');
  check({ 'index.ts': "import './paseo.js';", 'paseo.ts': "import './surfaces/new.js';", 'surfaces/new.ts': '' }, 'sdk-direction', 'surfaces/new.ts', fixturePkg, 'paseo.ts');
  check({ 'hosts/notifications.ts': 'process.env.PI_SESSION_ID;' }, 'ambient-env', 'hosts/notifications.ts');
  check({ 'api/types.ts': 'export const runtime = 1;' }, 'types-runtime', 'api/types.ts');
  for (const file of ['core/receive.ts', 'core/attention.ts']) check({ [file]: "import './model.js';" }, 'leaf-import', 'core/model.ts');
  check({ 'plugins/pi/helper.ts': "import '../../app/square.js'; import 'node:sqlite';" }, 'layer-direction', 'app/square.ts');
  check({ 'plugins/pi/helper.ts': "import '../../artifact/artifact.js';" }, 'artifact-private', 'artifact/artifact.ts');
  check({ 'core/new.ts': "import '../cli/program.js';" }, 'layer-direction', 'cli/program.ts');
  check({ 'index.ts': "import './square.js';" }, 'entry-import', 'square.ts');
  const pkg = { ...fixturePkg, exports: { ...fixturePkg.exports, './private': './dist/app/square.js' } };
  const split = { ...fixturePkg, exports: { ...fixturePkg.exports, './split': { types: './dist/app/square.d.ts', default: './dist/index.js' } } };
  const alias = { 'plugins/pi/alias.ts': `import type * as Hidden from '${pkg.name}/private';` };
  check(alias, 'app-private', 'app/square.ts', pkg);
  check(alias, 'package-alias', 'app/square.ts', pkg, './private');
  const mixed = { 'plugins/pi/alias.ts': `import { value, type Hidden } from '${split.name}/split';` };
  check(mixed, 'app-private', 'app/square.ts', split);
  check(mixed, 'package-alias', 'app/square.ts', split, './split');
  assert.ok(violations(sources, { ...fixturePkg, bin: { square: './wrong.js' } }).some(({ code }) => code === 'package-bin'));
  assert.ok(violations(sources, { ...fixturePkg, exports: { ...fixturePkg.exports, './missing': './dist/missing.js' } }).some(({ code }) => code === 'package-target'));
  for (const source of ["import './cli/help.js';", "import type { runCli } from './cli/program.js';"]) check({ 'square.ts': source }, 'entry-shape', undefined);
  const launcher = "flag ? '@astrosheep/keiyaku' : pathToFileURL(override).href";
  pass({ 'hosts/keiyaku-delivery.ts': `import(${launcher});` });
  check({ 'hosts/keiyaku-delivery.ts': `require(${launcher});` }, 'dynamic-import', undefined);
  pass({ 'core/new.ts': "function f(require) { return require('./missing.js'); }", 'api/types.ts': "import { type X } from '../core/model.js';" });
  pass({ 'core/new.ts': "const target = './model.js'; import(target);" });
  check({ 'packages/agent-delivery/src/new.ts': `import '${fixturePkg.name}';` }, 'layer-direction', 'index.ts');
  check({ 'core/new.ts': "import '@astrosheep/agent-delivery';" }, 'layer-direction', 'packages/agent-delivery/src/index.ts');
  check({ 'hosts/new.ts': "import '@astrosheep/agent-delivery';" }, 'agent-delivery-package', 'packages/agent-delivery/src/index.ts');
  check({ 'hosts/new.ts': "import '@astrosheep/agent-delivery/private';" }, 'agent-delivery-package', '@astrosheep/agent-delivery/private');
});
