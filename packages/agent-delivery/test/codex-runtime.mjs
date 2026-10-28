import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import { connect, DeliveryError } from '@astrosheep/agent-delivery'
import {
  handleCodexHook,
  createCodexBoundaryStore,
} from '@astrosheep/agent-delivery/codex-hook'
if (process.env.AGENT_DELIVERY_CODEX_LIVE_TEST !== '1')
  throw new Error(
    'Opt in with AGENT_DELIVERY_CODEX_LIVE_TEST=1. This starts only an isolated fixture server.'
  )
const binary = process.env.CODEX_BIN || 'codex'
const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
if (version !== 'codex-cli 0.160.1') throw new Error('This gate requires Codex 0.160.1.')
// Keep the default control socket below macOS's Unix socket path limit.
const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'ad-codex-runtime-')),
  log = [],
  requests = [],
  seen = []
console.log('Evidence: ' + root)
let service,
  owner,
  held,
  sequence = 0
const pending = new Map()
const record = (kind, value) => log.push({ n: log.length, kind, value })
const wait = async (fn, label) => {
  const until = Date.now() + 20000
  while (Date.now() < until) {
    const result = fn()
    if (result) return result
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error('wait: ' + label)
}
function send(value) {
  record('owner_send', value)
  owner.send(JSON.stringify(value))
}
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    send({ id, method, params })
  })
}
function sse(response, n, tool = false) {
  const events = [{ type: 'response.created', response: { id: 'resp_' + n } }]
  events.push({
    type: 'response.output_item.done',
    output_index: 0,
    item: tool
      ? { id: 'fc_probe', type: 'function_call', call_id: 'call_probe', name: 'probe_pause', arguments: '{}' }
      : {
          id: 'msg_' + n,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'probe done', annotations: [] }],
        },
  })
  events.push({
    type: 'response.completed',
    response: {
      id: 'resp_' + n,
      status: 'completed',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  })
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
}
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"data":[]}')
    return
  }
  const body = JSON.parse(raw)
  requests.push(body)
  record('provider_request', { url: req.url, body })
  if (requests.length === 1) {
    held = res
    return
  }
  sse(res, requests.length)
})
const watchdog = setTimeout(() => {
  owner?.terminate()
  service?.kill('SIGTERM')
  console.error('probe timeout')
  fs.writeFile(path.join(root, 'timeout-evidence.json'), JSON.stringify(log, null, 2)).finally(() =>
    process.exit(1)
  )
}, 25000)
try {
  for (const d of ['home', 'codex', 'work', 'sender-home'])
    await fs.mkdir(path.join(root, d), { recursive: true })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  await fs.mkdir(path.join(root, 'codex/app-server-control'))
  const endpoint = path.join(root, 'codex/app-server-control/app-server-control.sock')
  await fs.writeFile(
    path.join(root, 'codex/config.toml'),
    `model = "gpt-5.4"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "probe"\nbase_url = "http://127.0.0.1:${
      server.address().port
    }/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[analytics]\nenabled = false\n`
  )
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    CODEX_HOME: path.join(root, 'codex'),
    XDG_CONFIG_HOME: path.join(root, 'home/config'),
    XDG_CACHE_HOME: path.join(root, 'home/cache'),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
  for (const k of Object.keys(env)) if (/TOKEN|API_KEY|PASSWORD|SECRET/.test(k)) delete env[k]
  service = spawn(binary, ['app-server', '--listen', 'unix://' + endpoint], {
    env,
    cwd: path.join(root, 'work'),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  service.stderr.on('data', (c) => record('service_stderr', c.toString()))
  for (let i = 0; i < 500; i++) {
    try {
      await fs.stat(endpoint)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  const { connect: createSocket } = await import('node:net')
  owner = new WebSocket('ws://localhost/', { createConnection: () => createSocket({ path: endpoint }) })
  owner.on('error', () => {})
  owner.on('message', (raw) => {
    const value = JSON.parse(raw.toString())
    record('owner_receive', value)
    seen.push(value)
    const p = pending.get(value.id)
    if (p && ('result' in value || 'error' in value)) {
      pending.delete(value.id)
      value.error ? p.reject(new Error(JSON.stringify(value.error))) : p.resolve(value.result)
    }
  })
  await new Promise((resolve, reject) => {
    owner.once('open', resolve)
    owner.once('error', reject)
  })
  await call('initialize', {
    clientInfo: { name: 'delivery-live-owner', version: '0.0.0' },
    capabilities: { experimentalApi: true },
  })
  send({ method: 'initialized' })
  const started = await call('thread/start', {
    model: 'gpt-5.4',
    modelProvider: 'probe',
    cwd: path.join(root, 'work'),
    approvalPolicy: 'never',
    sandbox: 'read-only',
    dynamicTools: [
      {
        type: 'function',
        name: 'probe_pause',
        description: 'Harmless fixture tool',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  })
  const threadId = started.thread.id
  const agent = await connect({ harness: 'codex', sessionId: threadId, endpoint })
  let idleRejected = false,
    idleError
  try {
    await agent.steer('do not start idle')
  } catch (e) {
    idleError = { name: e.name, code: e.code, maybeDelivered: e.maybeDelivered }
    idleRejected = e instanceof DeliveryError && e.code === 'rejected' && !e.maybeDelivered
  }
  record('idle_error', idleError)
  await call('turn/start', {
    threadId,
    clientUserMessageId: 'initial-id',
    input: [{ type: 'text', text: 'INITIAL_PROBE', text_elements: [] }],
  })
  await wait(() => held, 'first model request')
  const steer = await agent.steer('STEER_PROBE_EXACT')
  const admissionBeforeConsumption = !seen.some(
    (e) => e.method === 'item/completed' && e.params?.item?.clientId === steer.id
  )
  const queued = await agent.queue('QUEUE_PROBE_EXACT')
  const boundaries = createCodexBoundaryStore(path.join(root, 'boundaries.json'))
  const cli = await connect({ harness: 'codex', transport: 'cli', sessionId: threadId, boundaries,
    bin: binary, endpoint: 'unix://' + endpoint, env: { ...env, CODEX_HOME: path.join(root, 'sender-home') } })
  const defaultCli = await connect({ harness: 'codex', transport: 'cli', sessionId: threadId, boundaries, bin: binary, env })
  let cliCount = 0,
    pendingText = 'CLI_QUEUE_PROBE_EXACT'
  await handleCodexHook(
    { session_id: threadId, hook_event_name: 'Stop' },
    {
      boundaries,
      sweep: async () => {
        if (pendingText) {
          await cli.queue(pendingText)
          cliCount++
          pendingText = undefined
        }
      },
    }
  )
  sse(held, 1, true)
  held = undefined
  const tool = await wait(() => seen.find((e) => e.method === 'item/tool/call'), 'fixture tool')
  send({
    id: tool.id,
    result: { contentItems: [{ type: 'inputText', text: 'harmless complete' }], success: true },
  })
  await wait(() => requests.length >= 4, 'native queues and CLI queue drained')
  await wait(() => seen.filter((e) => e.method === 'turn/completed').length >= 3, 'all turns complete')
  // No endpoint option: exercise the CLI's ordinary connection path as well.
  await defaultCli.queue('CLI_DEFAULT_PROBE_EXACT')
  await wait(() => requests.length >= 5, 'default CLI queue drained')
  await wait(() => seen.filter((e) => e.method === 'turn/completed').length >= 4, 'default CLI turn complete')
  const history = await call('thread/turns/list', { threadId, itemsView: 'full' })
  const hook = await handleCodexHook(
    { session_id: threadId, hook_event_name: 'PostToolUse' },
    { boundaries, pull: async () => '/literal hook 字' }
  )
  await handleCodexHook({ session_id: threadId, hook_event_name: 'SessionEnd' }, { boundaries })
  await handleCodexHook({ session_id: threadId, hook_event_name: 'Stop' }, { boundaries })
  let endedRejected = false
  try { await defaultCli.queue('MUST_NOT_START_AFTER_END') }
  catch (error) { endedRejected = error instanceof DeliveryError && error.code === 'session_inactive' && !error.maybeDelivered }
  const summary = {
    version,
    endpoint: 'explicit existing Unix socket',
    idleRejected,
    idleError,
    steer,
    queued,
    admissionBeforeConsumption,
    cliCount,
    cliUsedDifferentSenderHome: true,
    providerRequestCount: requests.length,
    steerInSecondRequest: JSON.stringify(requests[1]).includes('STEER_PROBE_EXACT'),
    queuesAbsentFromSecondRequest: !JSON.stringify(requests[1]).includes('QUEUE_PROBE_EXACT'),
    nativeQueueInThirdRequest: JSON.stringify(requests[2]).includes('QUEUE_PROBE_EXACT'),
    cliQueueInFourthRequest: JSON.stringify(requests[3]).includes('CLI_QUEUE_PROBE_EXACT'),
    defaultCliQueueInFifthRequest: JSON.stringify(requests[4]).includes('CLI_DEFAULT_PROBE_EXACT'),
    cliHasNoSteer: !('steer' in cli),
    endedRejected,
    correlationRecovered:
      JSON.stringify(history).includes(steer.id) && JSON.stringify(history).includes(queued.id),
    hookContext: hook.hookSpecificOutput.additionalContext,
    nonStopInvalidatedStop: !(await boundaries.queueEligible(threadId)),
  }
  await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  if (
    requests.length !== 5 ||
    cliCount !== 1 ||
    !Object.entries(summary)
      .filter(([, v]) => typeof v === 'boolean')
      .every(([, v]) => v)
  )
    throw new Error('live boolean check failed')
} catch (error) {
  record('probe_error', error.stack)
  console.error(error.stack)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  owner?.terminate()
  service?.kill('SIGTERM')
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(log, null, 2))
}
