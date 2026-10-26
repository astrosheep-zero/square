import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareSquareBuild, readSquareSnapshot } from '../dist/artifact.js';
import { Square } from '../dist/square-api.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('file, memory and public builds share configuration and guide preparation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-build-preparation-'));
  const markdown = '  context\r\nsecond line  ';
  const options = { markdown, throttlePerMinute: 3 };
  const expected = prepareSquareBuild(options, markdown);
  assert.equal(expected.hardCap, null);
  assert.deepEqual(expected.preamble, ['context', 'second line']);
  assert.equal(Object.hasOwn(prepareSquareBuild({}, ''), 'throttlePerMinute'), false);
  const memory = Square.inMemory(options);
  const filePath = path.join(dir, 'sdk.square');
  let file;
  try {
    file = await Square.build({ path: filePath, env: {}, ...options });
    const { delivered: memoryDelivered, ...memoryFacts } = await memory.snapshot();
    const { delivered: fileDelivered, ...fileFacts } = await file.snapshot();
    assert.deepEqual(memoryFacts, fileFacts);
    assert.deepEqual((await readSquareSnapshot(filePath)).state, expected);
    const appPath = path.join(dir, 'public.square');
    const result = await Square.build({ path: appPath, env: {}, ...options, template: 'architect' });
    assert.equal(result.location, appPath);
    const status = await result.status();
    assert.equal(status.hardCap, null);
    assert.equal(status.throttlePerMinute, 3);
    await result.close();
    assert.deepEqual((await readSquareSnapshot(appPath)).state,
      prepareSquareBuild({ ...options, template: 'architect' }, markdown));
    for (const invalid of [{ hardCap: 0 }, { throttlePerMinute: 0 }]) {
      assert.throws(() => Square.inMemory({ markdown, ...invalid }), { code: 'invalid_args' });
      await assert.rejects(Square.build({ path: path.join(dir, 'invalid.square'), markdown, env: {}, ...invalid }), { code: 'invalid_args' });
      await assert.rejects(Square.build({ path: appPath, markdown, ...invalid, force: true }), { code: 'invalid_args' });
    }
    assert.throws(() => prepareSquareBuild({ template: 'missing' }, ''), /Unknown square guide: missing/);
  } finally {
    await memory.close();
    if (file) await file.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ordinary storage/resource imports do not read guides; builds load and cache them synchronously', () => {
  const script = `
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    const read = fs.readFileSync;
    const readAsync = fs.promises.readFile;
    const guides = [];
    fs.readFileSync = function(file, ...args) {
      if (String(file).includes('/guides/')) guides.push({ file: String(file), mode: 'sync' });
      return read.call(this, file, ...args);
    };
    fs.promises.readFile = function(file, ...args) {
      if (String(file).includes('/guides/')) guides.push({ file: String(file), mode: 'async' });
      return readAsync.call(this, file, ...args);
    };
    await import('./dist/square-sqlite.js');
    const { prepareSquareBuild } = await import('./dist/artifact.js');
    const { Square } = await import('./dist/square-api.js');
    assert.deepEqual(guides, []);
    const memory = Square.inMemory({ markdown: '' });
    assert.equal(guides.length, 1);
    assert.match(guides[0].file, /participant\\.md$/);
    assert.equal(guides[0].mode, 'sync');
    prepareSquareBuild({}, '');
    assert.equal(guides.length, 1);
    prepareSquareBuild({ template: 'brainstorm' }, '');
    assert.equal(guides.length, 2);
    assert.equal(guides[1].mode, 'sync');
    await memory.close();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
