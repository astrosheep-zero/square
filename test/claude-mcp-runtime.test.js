import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createArtifactPort } from '../dist/artifact.js';
import { decodeHarnessOwner, harnessOwner } from '../dist/owner.js';

const repo = path.resolve(import.meta.dirname, '..');
const enabled = process.env.SQUARE_CLAUDE_MOD_NATIVE_SMOKE === '1';

test('native Claude mod preserves main/child MCP attribution, denies collision, and cleans completed calls', {
  skip: !enabled, timeout: 100_000,
}, async () => {
  assert.equal(process.platform, 'darwin');
  const binary = process.env.SQUARE_CLAUDE_BIN || '/Users/astrosheep/.local/bin/claude';
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/square-claude-mcp-mod-'));
  console.log(`Claude MCP mod evidence: ${root}`);
  const location = path.join(root, 'work/test.square');
  const { Square } = await import('../dist/square-api.js');
  const square = await Square.build({ path: location, markdown: 'Local Claude MCP ownership fixture' });
  await square.close();
  const run = spawnSync('python3', ['-B', path.join(repo, 'test/fixtures/claude-mcp-runtime.py'), repo, root, binary, process.execPath], {
    encoding: 'utf8', timeout: 85_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME'].includes(key))),
  });
  fs.writeFileSync(path.join(root, 'controller.log'), `${run.stdout ?? ''}${run.stderr ?? ''}`);
  assert.equal(run.status, 0, `Runtime failed: ${root}\n${run.stderr}\n${run.stdout}`);
  for (const name of ['hooks/hooks.json', 'hooks/register.js', '.mcp.json', '.claude-plugin/plugin.json'])
    assert.equal(fs.readFileSync(path.join(root, 'plugin', name), 'utf8'), fs.readFileSync(path.join(repo, 'plugins/claude', name), 'utf8'));
  const api = JSON.parse(fs.readFileSync(path.join(root, 'api.json'), 'utf8'));
  const schemas = api.flatMap(call => call.data.tools ?? []).filter(tool => tool.name.startsWith('mcp__plugin_square_square__'));
  assert.ok(schemas.some(tool => tool.name === 'mcp__plugin_square_square__join'));
  for (const tool of schemas) for (const field of ['sessionId', 'agentId', 'toolUseId'])
    assert.equal(field in (tool.input_schema.properties ?? {}), false, `${tool.name} exposes ${field}`);
  const read = name => fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n').map(JSON.parse);
  const invocations = read('invocations.jsonl');
  const sessionId = invocations.find(row => row.argv[0] === 'claude-mod').input.sessionId;
  const requests = read('mcp-in.jsonl'), responses = read('mcp-out.jsonl');
  for (const name of ['main', 'child']) {
    const request = requests.find(row => row.method === 'tools/call' && row.params._meta?.['claudecode/toolUseId'] === `toolu_fixture_${name}`);
    assert.ok(request, `Missing native MCP call metadata for ${name}`);
    assert.deepEqual(request.params.arguments, { location: 'test.square', as: name });
    assert.ok(responses.some(row => row.id === request.id && row.result && !row.result.isError));
  }
  const artifact = await createArtifactPort(location);
  try {
    const seats = (await artifact.read(facts => ['main', 'child'].map(name => facts.seat(name)))).value;
    assert.equal(seats[0].owner, harnessOwner({ channel: 'claude-code', session: sessionId }));
    const child = decodeHarnessOwner(seats[1].owner);
    assert.equal(child.channel, 'claude-code');
    assert.equal(child.session, sessionId);
    assert.ok(child.agent);
    assert.notEqual(seats[1].owner, seats[0].owner);
    assert.equal((await artifact.read(facts => facts.seat('must-not-join'))).value, undefined);
  } finally { await artifact.close(); }
  assert.ok(api.some(row => JSON.stringify(row.data.messages).includes('NATIVE_DURING_TURN_TOOL_NOTICE')),
    'Context appended during the native main/child turn must reach a later model request');
  const maps = fs.readdirSync(path.join(root, 'claude-mcp-calls'));
  const stored = maps.filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(root, 'claude-mcp-calls', name), 'utf8')));
  assert.deepEqual(stored.map(call => [call.toolUseId, call.sessionId]), [['toolu_fixture_collision', 'foreign-session']]);
  assert.equal(requests.some(row => row.method === 'tools/call' && row.params._meta?.['claudecode/toolUseId'] === 'toolu_fixture_collision'), false);
  assert.ok(api.some(row => JSON.stringify(row.data.messages).includes('Square MCP call identity is unavailable')));
});
