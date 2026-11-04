// Opt-in evidence against the installed native runtime. No account, real HOME,
// daemon, installed plugin, or user session is used. Run with test/sandbox-env.js.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { postAndDispatch } from '../dist/notifications.js';
import { codexBoundaryStore } from '../dist/codex-boundary-state.js';
import { codexIdleAtStop } from '../dist/packages/agent-delivery/src/codex.js';

if (process.env.SQUARE_CODEX_NATIVE_SMOKE !== '1') throw new Error('Set SQUARE_CODEX_NATIVE_SMOKE=1 to run the isolated native smoke.');
const binary = process.env.CODEX_BIN ?? '/opt/homebrew/bin/codex';
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim();
assert.equal(version, 'codex-cli 0.166.0', 'Newest-last history is verified only for this runtime.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-codex-native-'));
const cli = fileURLToPath(new URL('../dist/square.js', import.meta.url));
const evidence = { root, version, checks: [], requests: [], events: [], limitations: [
  'Interrupt was exercised through turn/interrupt RPC; physical TUI Esc is not verified.',
  'Native idle reads and external queue are not atomic. Already-admitted messages cannot be recalled.',
  'This short smoke does not prove 24-hour lifetime, crash-idle recovery or arbitrary resume behavior.',
] };
const save = () => fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
const check = (name, detail = {}) => { evidence.checks.push({ name, ...detail }); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, name, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await predicate(); if (result) return result; await pause(25); }
  throw new Error(`Timed out: ${name}`);
}
const shell = value => `'${value.replaceAll("'", "'\\''")}'`;
for (const dir of ['home', 'codex', 'work']) await fs.mkdir(path.join(root, dir));
const env = { ...process.env, HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex'),
  XDG_CONFIG_HOME: path.join(root, 'home/config'), XDG_CACHE_HOME: path.join(root, 'home/cache'),
  SQUARE_DELIVERY: path.join(root, 'delivery.sqlite'), SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json'),
  SQUARE_DISABLE_PASEO_WAKE: '1', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
for (const key of Object.keys(env)) if (/TOKEN|API_KEY|PASSWORD|SECRET/.test(key)) delete env[key];
const endpoint = path.join(root, 'codex/control.sock');
env.SQUARE_CODEX_ENDPOINT = `unix://${endpoint}`;
const hookLog = path.join(root, 'hooks.jsonl'), queueLog = path.join(root, 'queues.txt');
// Capture the original native payload, then run the actual shipped CLI. Children
// stay in the native hook's process group; no detached helper is introduced.
const wrapper = path.join(root, 'hook.mjs');
await fs.writeFile(wrapper, `import fs from 'node:fs';import {spawn} from 'node:child_process';
let input='';for await(const chunk of process.stdin)input+=chunk;
const command=process.argv[2], payload=JSON.parse(input);
const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},command],{env:process.env,stdio:['pipe','inherit','inherit']});
const record=value=>fs.appendFileSync(${JSON.stringify(hookLog)},JSON.stringify({t:Date.now(),command,pid:process.pid,child:child.pid,event:payload.hook_event_name,turn:payload.turn_id,...value})+'\\n');
record({stage:'start'});child.stdin.end(input);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('exit',(code,signal)=>{record({stage:'exit',code,signal});process.exit(code??1)});
`);
const queueWrapper = path.join(root, 'queue');
await fs.writeFile(queueWrapper, `#!/bin/sh\nprintf '%s\\n' "$$" >> ${shell(queueLog)}\nexec ${shell(binary)} "$@"\n`, { mode: 0o700 });
env.SQUARE_CODEX_BIN = queueWrapper;
const hooks = JSON.parse(await fs.readFile(new URL('../plugins/codex/hooks/hooks.json', import.meta.url), 'utf8'));
for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const hook of group.hooks)
  hook.command = `${shell(process.execPath)} ${shell(wrapper)} ${hook.command.slice('square '.length)}`;
await fs.writeFile(path.join(root, 'codex/hooks.json'), JSON.stringify(hooks));
const readHooks = async () => (await fs.readFile(hookLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
const queues = async () => (await fs.readFile(queueLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
let holdNext = false;
const held = new Map();
function complete(response, n) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const events = [
    { type: 'response.created', response: { id: `r${n}` } },
    { type: 'response.output_item.done', output_index: 0, item: { id: `m${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] } },
    { type: 'response.completed', response: { id: `r${n}`, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
const provider = http.createServer(async (request, response) => {
  if (request.method === 'GET') { response.end('{"data":[]}'); return; }
  let body = ''; for await (const part of request) body += part;
  const n = evidence.requests.length + 1;
  evidence.requests.push({ n, body: JSON.parse(body) });
  if (holdNext) { holdNext = false; held.set(n, response); }
  else complete(response, n);
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
await fs.writeFile(path.join(root, 'codex/config.toml'), `model="gpt-5.4"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[analytics]\nenabled=false\n`);
let app, appExit, socket, ledger, appLog;
const pending = new Map(); let sequence = 0;
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
let owner, threadId;
const nativeRead = () => call('thread/read', { threadId, includeTurns: true });
const idle = async () => {
  const result = await nativeRead();
  return result.thread.status.type === 'idle' && result.thread.turns.at(-1)?.status === 'completed' ? result.thread.turns.at(-1) : undefined;
};
try {
  app = spawn(binary, ['--dangerously-bypass-hook-trust', 'app-server', '--listen', `unix://${endpoint}`], { cwd: path.join(root, 'work'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  appExit = once(app, 'exit');
  appLog = await fs.open(path.join(root, 'app-server.log'), 'a');
  app.stderr.on('data', chunk => { void appLog.appendFile(chunk); });
  app.stdout.on('data', chunk => { void appLog.appendFile(chunk); });
  await until(() => existsSync(endpoint), 'native app-server endpoint');
  socket = new WebSocket('ws://localhost/', { createConnection: () => createConnection({ path: endpoint }) });
  await once(socket, 'open');
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.method) evidence.events.push(message);
    const request = pending.get(message.id);
    if (request && ('result' in message || 'error' in message)) {
      pending.delete(message.id);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    }
  });
  evidence.initialize = await call('initialize', { clientInfo: { name: 'square-native-smoke', version: '1' }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: 'initialized' }));
  threadId = (await call('thread/start', { model: 'gpt-5.4', modelProvider: 'fixture', cwd: path.join(root, 'work'), approvalPolicy: 'never', sandbox: 'read-only', config: { bypass_hook_trust: true } })).thread.id;
  owner = `codex:${threadId}`;
  ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  await call('turn/start', { threadId, input: [{ type: 'text', text: 'initial native turn', text_elements: [] }] });
  await until(async () => (await readHooks()).some(row => row.command === 'codex-watch' && row.stage === 'start'), 'native async Stop hook');
  const firstStop = await until(idle, 'first completed native turn');
  await until(async () => (await codexBoundaryStore(env).read(threadId))?.stop?.turnId === firstStop.id, 'synchronous Stop epoch');
  assert.equal((await ledger.session(owner)).state, 'attached');
  const firstWatcher = (await readHooks()).find(row => row.command === 'codex-watch' && row.stage === 'start');
  check('native SessionStart attached and async Stop started', { watcher: firstWatcher.child, stop: firstStop.id });

  evidence.firstIdle = await nativeRead();
  evidence.session = await ledger.session(owner);
  evidence.nativeGate = await codexIdleAtStop({ harness: 'codex', sessionId: threadId, endpoint: env.SQUARE_CODEX_ENDPOINT, timeoutMs: 2000 }, firstStop.id);
  assert.equal(evidence.nativeGate, true, 'native helper recognizes verified completed idle turn');
  await postAndDispatch(ledger, { owner, key: 'idle-card', text: 'NATIVE_IDLE_CARD_086c' }, { env });
  await until(() => evidence.requests.length >= 2, 'idle self-queue woke next native turn');
  await until(idle, 'self-queued turn completed');
  assert.equal((await queues()).length, 1);
  assert.match(JSON.stringify(evidence.requests[1].body), /NATIVE_IDLE_CARD_086c/);
  assert.deepEqual(await ledger.receipts(owner), []);
  check('receiver idle self-queue woke next turn; admission is custody');
  await until(async () => (await readHooks()).some(row => row.command === 'codex-watch' && row.stage === 'exit' && row.child !== firstWatcher.child), 'duplicate watcher exited');
  process.kill(firstWatcher.child, 0);
  check('subsequent native Stop duplicate exited; original singleton remains');

  holdNext = true;
  await call('turn/start', { threadId, input: [{ type: 'text', text: 'busy native turn', text_elements: [] }] });
  await until(() => held.has(3), 'busy native model request');
  await postAndDispatch(ledger, { owner, key: 'busy-card', text: 'NATIVE_BUSY_CARD_086c' }, { env });
  await pause(1300); // At least one receiver boundary rescan while native busy.
  assert.equal((await queues()).length, 1);
  assert.equal((await nativeRead()).thread.status.type, 'active');
  check('busy native turn blocked deliberate watcher enqueue');
  complete(held.get(3), 3); held.delete(3);
  await until(() => evidence.requests.length >= 4, 'busy card queued after its verified Stop');
  await until(idle, 'later self-queue completed');
  assert.equal((await queues()).length, 2);
  assert.match(JSON.stringify(evidence.requests[3].body), /NATIVE_BUSY_CARD_086c/);
  process.kill(firstWatcher.child, 0);
  check('same watcher followed new Stop and delivered busy card exactly once');

  holdNext = true;
  const interruptTurn = await call('turn/start', { threadId, input: [{ type: 'text', text: 'interrupt native turn', text_elements: [] }] });
  await until(() => held.has(5), 'interrupt native request');
  await postAndDispatch(ledger, { owner, key: 'cancelled-card', text: 'NATIVE_CANCELLED_CARD_086c' }, { env });
  await call('turn/interrupt', { threadId, turnId: interruptTurn.turn.id });
  await until(async () => (await readHooks()).some(row => row.event === 'Interrupt' && row.stage === 'exit' && row.code === 0), 'synchronous native Interrupt');
  const session = await ledger.session(owner);
  assert.deepEqual(await ledger.pending(owner, { generation: session.generation }), []);
  assert.equal(await codexBoundaryStore(env).queueEligible(threadId), false);
  check('native turn/interrupt hook cancelled captured pending batch and disarmed');
  await ledger.post({ owner, key: 'future-card', text: 'NATIVE_FUTURE_CARD_086c' });
  await pause(1300);
  assert.equal((await queues()).length, 2);
  await call('turn/start', { threadId, input: [{ type: 'text', text: 'resume after interrupt', text_elements: [] }] });
  await until(() => evidence.requests.length >= 6, 'new prompt after interrupt');
  assert.match(JSON.stringify(evidence.requests[5].body), /NATIVE_FUTURE_CARD_086c/);
  assert.doesNotMatch(JSON.stringify(evidence.requests[5].body), /NATIVE_CANCELLED_CARD_086c/);
  await until(idle, 'last native turn completed');
  check('future card presented by actual UserPromptSubmit; cancelled card did not revive');

  const live = (await readHooks()).filter(row => row.command === 'codex-watch' && row.stage === 'start').map(row => row.child);
  socket.close(); app.kill('SIGTERM'); await appExit;
  await until(() => live.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'native shutdown ended all watcher processes');
  check('native app-server shutdown terminated async hook descendants', { pids: live });
  evidence.hooks = await readHooks(); evidence.queuePids = await queues();
  evidence.ok = true;
} catch (error) {
  evidence.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  socket?.terminate();
  if (app?.exitCode === null) { app.kill('SIGTERM'); await appExit; }
  for (const response of held.values()) response.destroy();
  await new Promise(resolve => provider.close(resolve));
  await ledger?.close();
  await appLog?.close();
  await save();
  console.log(JSON.stringify({ root, ok: evidence.ok ?? false, checks: evidence.checks.map(row => row.name), failure: evidence.failure }, null, 2));
}
