import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../', import.meta.url));
const plugin = path.join(repo, 'plugins/claude');
const driver = path.join(repo, 'test/fixtures/claude-mcp-runtime.py');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('shipped Claude MCP correlates main/child calls and removes call maps', {
  skip: process.env.SQUARE_CLAUDE_LIVE_TEST !== '1', timeout: 100_000,
}, async () => {
  assert.ok(process.env.SQUARE_CLAUDE_BIN, 'Set SQUARE_CLAUDE_BIN explicitly for the opt-in runtime');
  const binary = path.resolve(process.env.SQUARE_CLAUDE_BIN);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'square-claude-mcp-runtime-')));
  console.log(`Claude MCP runtime evidence: ${root}`);
  // Preserve scratch evidence on success and failure; never touch user configuration.
  const { Square } = await import('../dist/square-api.js');
  fs.mkdirSync(path.join(root, 'work'));
  const location = path.join(root, 'work/test.square');
  const square = await Square.build({ path: location, markdown: 'Local Claude MCP ownership fixture' });
  await square.close();
  const run = spawnSync('python3', ['-B', driver, repo, root, binary, process.execPath], {
    encoding: 'utf8', timeout: 85_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME'].includes(key))),
  });
  fs.writeFileSync(path.join(root, 'controller.log'), `${run.stdout ?? ''}${run.stderr ?? ''}`);
  assert.equal(run.status, 0, `Runtime failed: ${root}\n${run.stderr}\n${run.stdout}`);
  // Prove that the candidate hook/manifest, not a stand-in, executed.
  for (const name of ['hooks/register.js', 'hooks/hooks.json', '.mcp.json', '.claude-plugin/plugin.json']) {
    assert.equal(fs.readFileSync(path.join(root, 'plugin', name), 'utf8'), fs.readFileSync(path.join(plugin, name), 'utf8'));
  }
  const api = json(path.join(root, 'api.json'));
  const schemas = api.flatMap(call => call.data.tools ?? []).filter(tool => tool.name.startsWith('mcp__plugin_square_square__'));
  for (const tool of schemas) {
    for (const field of ['sessionId', 'agentId', 'toolUseId']) {
      assert.equal(field in (tool.input_schema.properties ?? {}), false, `${tool.name} exposes ${field}`);
    }
  }
  const bridges = lines(path.join(root, 'bridge.jsonl'));
  const requests = lines(path.join(root, 'mcp-in.jsonl'));
  const responses = lines(path.join(root, 'mcp-out.jsonl'));
  const begins = new Map();
  for (const name of ['main', 'child']) {
    const id = `toolu_fixture_${name}`;
    const begin = bridges.find(row => row.input.operation === 'tool-begin' && row.input.toolUseId === id);
    assert.ok(begin, `Missing shipped mod begin ${id}`);
    assert.equal(begin.exit, 0, begin.stderr);
    begins.set(name, begin.input);
    const request = requests.find(row => row.method === 'tools/call' && row.params._meta?.['claudecode/toolUseId'] === id);
    assert.ok(request, `No matching MCP metadata ${id}`);
    assert.equal(request.params.name, 'join');
    assert.deepEqual(request.params.arguments, { location: 'test.square', as: name });
    const response = responses.find(row => row.id === request.id && row.result);
    assert.ok(response, `No MCP response ${id}`);
    assert.ok(!response.result.isError, JSON.stringify(response));
    assert.ok(bridges.some(row => row.input.operation === 'tool-end' && row.input.toolUseId === id && row.exit === 0));
  }
  const main = begins.get('main'), child = begins.get('child');
  assert.equal(main.agentId, undefined);
  assert.ok(child.agentId);
  assert.equal(child.sessionId, main.sessionId);
  const transcripts = fs.readdirSync(path.join(root, 'config/projects'), { recursive: true });
  assert.ok(transcripts.some(name => path.basename(name) === `agent-${child.agentId}.jsonl`), 'Mapped agentId must match the native child transcript');
  const maps = fs.readdirSync(path.join(root, 'ledger/claude-mcp-calls'));
  assert.deepEqual(maps.filter(name => name.endsWith('.json') || name.endsWith('.tmp')), [], 'Completed tool calls must remove their maps');
});
