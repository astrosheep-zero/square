import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('delivery evidence writers and health labels stay inside their owning modules', () => {
  const sources = fs.readdirSync(ROOT)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => [name, fs.readFileSync(path.join(ROOT, name), 'utf8')]);
  const labels = ['wake-accepted', 'wake-unknown', 'presented-not-delivered', 'unreachable'];
  for (const [name, source] of sources) {
    if (name === 'delivery-health.ts') continue;
    for (const label of labels) assert.equal(source.includes(label), false, `${label} leaked into ${name}`);
  }
  for (const name of ['notifications.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, name), 'utf8'), /delivery-health/);
  }

  const sourceByName = new Map(sources);
  const closure = new Set();
  const visit = (name) => {
    if (closure.has(name)) return;
    closure.add(name);
    const source = sourceByName.get(name);
    if (source === undefined) return;
    const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    for (const node of parsed.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) continue;
      if (ts.isExportDeclaration(node) && node.isTypeOnly) continue;
      const match = /^\.\/(.+)\.js$/.exec(node.moduleSpecifier.text);
      if (match) visit(`${match[1]}.ts`);
    }
  };
  visit('delivery-health.ts');
  assert.equal(closure.has('notifications.ts'), false);
  for (const name of closure) {
    assert.doesNotMatch(sourceByName.get(name) ?? '', /node:child_process/, `${name} gives delivery health process effects`);
  }
});
