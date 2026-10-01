import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'jsonc-parser';

import { uninstallOpenCodePlugin } from '../dist/harness-links.js';
import { nodeCommandFixture } from './node-command-fixture.js';
import { run } from './square-cli-helpers.js';

const square = '@astrosheep/square';

function fixture(t, configs = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'square-opencode-config-'));
  const configHome = path.join(home, 'xdg');
  const directory = path.join(configHome, 'opencode');
  fs.mkdirSync(directory, { recursive: true });
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const [name, source] of Object.entries(configs)) fs.writeFileSync(path.join(directory, name), source);
  return { home, configHome, directory, read: (name) => fs.readFileSync(path.join(directory, name), 'utf8') };
}

test('OpenCode uninstall structurally removes every Square entry and only necessary separators', (t) => {
  const item = fixture(t);
  const cases = [
    [square],
    [square, 'other'],
    ['other', square],
    ['first', square, 'last'],
    [square, `${square}@1.2.3`, 'other'],
    [`${square}@latest`, 'other', square],
  ];
  for (const plugin of cases) {
    const original = {
      plugin,
      model: 'provider/model',
      provider: { example: { options: { plugin: [square] } } },
      description: `Keep ${square} in ordinary settings`,
    };
    const target = path.join(item.directory, 'opencode.json');
    fs.writeFileSync(target, JSON.stringify(original));
    assert.deepEqual(uninstallOpenCodePlugin(item.home), [square]);
    assert.deepEqual(JSON.parse(item.read('opencode.json')), {
      ...original, plugin: plugin.filter((entry) => !entry.startsWith(square)),
    });
    const after = item.read('opencode.json');
    assert.deepEqual(uninstallOpenCodePlugin(item.home), []);
    assert.equal(item.read('opencode.json'), after);
  }
});

test('OpenCode JSONC removal preserves comments, unrelated registrations, and settings verbatim', (t) => {
  const source = `// settings header\r\n{\r\n  "plugin": [/* before */ "${square}" /* after */, // beside removed entry\r\n    "other", /* other plugin */ "${square}@^0.3",], // list end\r\n  "model": "provider/model",\r\n  "url": "https://example.com//keep",\r\n  "description": "${square}", // keep this setting\r\n}\r\n`;
  const item = fixture(t, { 'opencode.jsonc': source });
  assert.deepEqual(uninstallOpenCodePlugin(item.home), [square]);
  assert.equal(item.read('opencode.jsonc'), source
    .replace(`"${square}" /* after */,`, ' /* after */')
    .replace(`"${square}@^0.3",`, ''));
  assert.deepEqual(parse(item.read('opencode.jsonc')).plugin, ['other']);
});

test('OpenCode uninstall recognizes versioned and option-bearing registrations without matching other packages', (t) => {
  const keep = [`${square}-tools`, '@elsewhere/square', `file:///plugins/${square}`, ['other', { enabled: true }]];
  const item = fixture(t, {
    'opencode.json': JSON.stringify({ plugin: [square, [ `${square}@next`, { enabled: true } ], ...keep] }),
  });
  assert.deepEqual(uninstallOpenCodePlugin(item.home), [square]);
  assert.deepEqual(JSON.parse(item.read('opencode.json')).plugin, keep);
});

test('OpenCode uninstall cleans every merged global source and honors XDG_CONFIG_HOME', (t) => {
  const item = fixture(t, {
    'config.json': JSON.stringify({ plugin: [`${square}@0.1`, 'legacy-other'] }),
    'opencode.json': JSON.stringify({ plugin: [square, 'json-other'], model: 'kept' }),
    'opencode.jsonc': `{"plugin":["${square}@latest", "jsonc-other",], /* keep */ "theme":"kept"}`,
  });
  const defaultConfig = path.join(item.home, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(defaultConfig), { recursive: true });
  fs.writeFileSync(defaultConfig, JSON.stringify({ plugin: [square] }));
  assert.deepEqual(uninstallOpenCodePlugin(item.home), [square]);
  for (const [file, other] of [['config.json', 'legacy-other'], ['opencode.json', 'json-other'], ['opencode.jsonc', 'jsonc-other']]) {
    assert.deepEqual(parse(item.read(file)).plugin, [other]);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(defaultConfig, 'utf8')).plugin, [square]);
});

test('OpenCode uninstall leaves absent, empty, and unrelated configs unchanged', (t) => {
  const configs = {
    'config.json': '',
    'opencode.json': '{"model":"kept"}',
    'opencode.jsonc': '// comments only\n',
  };
  const item = fixture(t, configs);
  assert.deepEqual(uninstallOpenCodePlugin(item.home), []);
  for (const [file, source] of Object.entries(configs)) assert.equal(item.read(file), source);
  for (const file of Object.keys(configs)) fs.rmSync(path.join(item.directory, file));
  assert.deepEqual(uninstallOpenCodePlugin(item.home), []);
  assert.deepEqual(fs.readdirSync(item.directory), []);
});

test('OpenCode validates all global sources before changing any of them', (t) => {
  const source = JSON.stringify({ plugin: [square, 'other'] });
  const item = fixture(t, { 'opencode.json': source });
  const target = path.join(item.directory, 'opencode.jsonc');
  for (const invalid of ['{"plugin":[', '{"plugin":[], "plugin":[]}', '{"plugin":"not-an-array"}', '[]']) {
    fs.writeFileSync(target, invalid);
    assert.throws(() => uninstallOpenCodePlugin(item.home), /(?:Invalid|Ambiguous) OpenCode config .*opencode\.jsonc/);
    assert.equal(item.read('opencode.json'), source);
    assert.equal(item.read('opencode.jsonc'), invalid);
  }
  fs.rmSync(target);
  fs.mkdirSync(target);
  assert.throws(() => uninstallOpenCodePlugin(item.home), /EISDIR|illegal operation on a directory/i);
  assert.equal(item.read('opencode.json'), source);
});

test('OpenCode CLI uninstall removes JSON and compact JSONC registrations without invoking the host', (t) => {
  const item = fixture(t, {
    'opencode.json': JSON.stringify({ plugin: [square, 'other'] }),
    'opencode.jsonc': `{"plugin":["${square}@latest"], /* preserved */ "model":"kept"}`,
  });
  const called = path.join(item.home, 'host-was-called');
  const fake = nodeCommandFixture('square-opencode-must-not-run', `
    require('node:fs').writeFileSync(${JSON.stringify(called)}, 'unexpected host command');
    process.exit(91);
  `);
  t.after(() => fs.rmSync(fake.root, { recursive: true, force: true }));
  const env = {
    HOME: item.home,
    USERPROFILE: item.home,
    XDG_CONFIG_HOME: item.configHome,
    SQUARE_HOST_LEDGER_ROOT: path.join(item.home, 'host-ledger'),
    SQUARE_OPENCODE_BIN: fake.bin,
    SQUARE_OPENCODE_BIN_ARGS: JSON.stringify(fake.args),
  };
  const result = run(['uninstall', 'opencode'], { cwd: item.home, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), square);
  assert.deepEqual(JSON.parse(item.read('opencode.json')).plugin, ['other']);
  assert.deepEqual(parse(item.read('opencode.jsonc')), { plugin: [], model: 'kept' });
  assert.match(item.read('opencode.jsonc'), /\/\* preserved \*\//);
  assert.equal(fs.existsSync(called), false);
  const repeated = run(['uninstall', 'opencode'], { cwd: item.home, env });
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  assert.equal(repeated.stdout.trim(), '');
  assert.equal(fs.existsSync(called), false);

  const source = JSON.stringify({ plugin: [square] });
  fs.writeFileSync(path.join(item.directory, 'opencode.json'), source);
  fs.writeFileSync(path.join(item.directory, 'opencode.jsonc'), '{"plugin":[');
  const failed = run(['uninstall', 'opencode'], { cwd: item.home, env });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /opencode uninstall failed: Invalid OpenCode config .*opencode\.jsonc/);
  assert.doesNotMatch(failed.stdout, /^@astrosheep\/square$/m);
  assert.equal(item.read('opencode.json'), source);
  assert.equal(fs.existsSync(called), false);
});
