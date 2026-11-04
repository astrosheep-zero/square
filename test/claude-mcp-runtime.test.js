import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createArtifactPort } from '../dist/artifact.js';
import { harnessOwner } from '../dist/owner.js';

const repo = path.resolve(import.meta.dirname, '..');
const enabled = process.env.SQUARE_CLAUDE_HOOK_NATIVE_SMOKE === '1';

test('native Claude MCP hooks preserve main/child call attribution and clean exact calls', {
  skip: !enabled, timeout: 100_000,
}, async t => {
  assert.equal(process.platform, 'darwin');
  const binary = process.env.SQUARE_CLAUDE_BIN || '/Users/astrosheep/.local/bin/claude';
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/square-claude-mcp-hooks-'));
  console.log(`Claude MCP hook evidence: ${root}`);
  // Preserve isolated runtime evidence after the test.
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
  for (const name of ['hooks/hooks.json', '.mcp.json', '.claude-plugin/plugin.json']) {
    assert.equal(fs.readFileSync(path.join(root, 'plugin', name), 'utf8'), fs.readFileSync(path.join(repo, 'plugins/claude', name), 'utf8'));
  }
  const api = JSON.parse(fs.readFileSync(path.join(root, 'api.json'), 'utf8'));
  const schemas = api.flatMap(call => call.data.tools ?? []).filter(tool => tool.name.startsWith('mcp__plugin_square_square__'));
  assert.ok(schemas.some(tool => tool.name === 'mcp__plugin_square_square__join'));
  for (const tool of schemas) for (const field of ['sessionId', 'agentId', 'toolUseId'])
    assert.equal(field in (tool.input_schema.properties ?? {}), false, `${tool.name} exposes ${field}`);

  const invocations = fs.readFileSync(path.join(root, 'invocations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .map(row => row.input).filter(Boolean);
  const pre = new Map(invocations.filter(row => row.hook_event_name === 'PreToolUse').map(row => [row.tool_use_id, row]));
  const post = new Set(invocations.filter(row => row.hook_event_name === 'PostToolUse' || row.hook_event_name === 'PostToolUseFailure').map(row => row.tool_use_id));
  const requests = fs.readFileSync(path.join(root, 'mcp-in.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const responses = fs.readFileSync(path.join(root, 'mcp-out.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const identities = {};
  for (const name of ['main', 'child']) {
    const id = `toolu_fixture_${name}`;
    const hook = pre.get(id);
    assert.ok(hook, `Missing native PreToolUse ${id}`);
    assert.ok(post.has(id), `Missing native terminal hook ${id}`);
    const request = requests.find(row => row.method === 'tools/call' && row.params._meta?.['claudecode/toolUseId'] === id);
    assert.ok(request, `No matching native MCP metadata ${id}`);
    assert.equal(request.params.name, 'join');
    assert.deepEqual(request.params.arguments, { location: 'test.square', as: name });
    assert.ok(responses.some(row => row.id === request.id && row.result && !row.result.isError));
    identities[name] = hook;
  }
  assert.equal(identities.main.agent_id, undefined);
  assert.ok(identities.child.agent_id);
  assert.equal(identities.child.session_id, identities.main.session_id);
  const artifact = await createArtifactPort(location);
  try {
    const seats = (await artifact.read(facts => ['main', 'child'].map(name => ({ name, seat: facts.seat(name) })))).value;
    assert.equal(seats.find(row => row.name === 'main').seat.owner,
      harnessOwner({ channel: 'claude-code', session: identities.main.session_id }));
    assert.equal(seats.find(row => row.name === 'child').seat.owner,
      harnessOwner({ channel: 'claude-code', session: identities.child.session_id, agent: identities.child.agent_id }));
  } finally { await artifact.close(); }
  const bridges = fs.readFileSync(path.join(root, 'bridge.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(pre.has('toolu_fixture_agent'), false, 'Ordinary tools must not start the MCP identity hook');
  assert.equal(post.has('toolu_fixture_agent'), true, 'Ordinary tool completion remains a delivery boundary');
  const presented = bridges.find(row => row.input.hook_event_name === 'PostToolUse'
    && row.input.tool_use_id === 'toolu_fixture_agent' && row.stdout.includes('NATIVE_DURING_TURN_TOOL_NOTICE'));
  assert.ok(presented, 'The next legitimate native tool boundary must present a card posted during the turn');
  assert.equal(JSON.parse(presented.stdout).hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(api.some(row => JSON.stringify(row.data.messages).includes('NATIVE_DURING_TURN_TOOL_NOTICE')),
    'Native tool additionalContext must reach a provider request');
  const maps = fs.readdirSync(path.join(root, 'claude-mcp-calls'));
  const stored = maps.filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(root, 'claude-mcp-calls', name), 'utf8')));
  assert.deepEqual(stored.map(call => [call.toolUseId, call.sessionId]), [['toolu_fixture_collision', 'foreign-session']],
    'Only the unrelated pre-existing call may remain; completed native main/child calls are removed');
  assert.equal(requests.some(row => row.method === 'tools/call' && row.params._meta?.['claudecode/toolUseId'] === 'toolu_fixture_collision'), false,
    'PreToolUse identity failure must deny the actual native MCP call');
  assert.ok(bridges.some(row => row.input.tool_use_id === 'toolu_fixture_collision'
    && row.stdout && JSON.parse(row.stdout).hookSpecificOutput?.permissionDecision === 'deny'));
  assert.ok(api.some(row => JSON.stringify(row.data.messages).includes('Square MCP call identity is unavailable')));
  console.log(`main/child native MCP identity and cleanup passed: ${root}`);
});
