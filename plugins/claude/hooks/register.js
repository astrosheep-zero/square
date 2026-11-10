// The mod owns native lifecycle and effects. Its one helper owns Node/SQLite.
let runtime;
let starting;

async function rpc($, current, input) {
  const response = await $.http.fetch(current.url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error('Square Claude helper request failed');
  return JSON.parse(response.text);
}

async function closeRuntime($, current) {
  if (!current || current.closed) return;
  current.closed = true;
  current.epoch++;
  try { await rpc($, current, { op: 'close' }); } catch { /* The helper may already have exited. */ }
  await current.stream.return().catch(() => undefined);
}

async function startRuntime($, sessionId) {
  const stream = $.process.spawn({ argv: ['square', 'claude-mod'], input: JSON.stringify({ sessionId }) });
  const current = { sessionId, stream, url: '', buffer: '', closed: false, epoch: 0, epochs: new Map(), modes: new Map([['', 'idle']]) };
  try {
    while (!current.url) {
      const chunk = await stream.next();
      if (chunk.done) throw new Error('Square Claude helper ended before startup');
      if (chunk.value.stream !== 'stdout') { $.ui.log(chunk.value.text, { to: 'debug' }); continue; }
      current.buffer += chunk.value.text;
      const end = current.buffer.indexOf('\n');
      if (end < 0) continue;
      const ready = JSON.parse(current.buffer.slice(0, end));
      current.buffer = current.buffer.slice(end + 1);
      if (ready.type !== 'ready' || !/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/.test(ready.url)) throw new Error('Invalid Square Claude helper address');
      current.url = ready.url;
    }
    // A session.start/tool hook must never hold the turn while waiting on submit.
    $.clock.after(0, async () => readDeliveries($, current));
    return current;
  } catch (error) {
    await stream.return().catch(() => undefined);
    throw error;
  }
}

async function ensureRuntime($) {
  const sessionId = await $.session.id();
  if (runtime && !runtime.closed && runtime.sessionId === sessionId) return runtime;
  if (starting) { await starting; return ensureRuntime($); }
  starting = (async () => {
    await closeRuntime($, runtime);
    const next = await startRuntime($, sessionId);
    runtime = next;
    return next;
  })();
  try { return await starting; } finally { starting = undefined; }
}

async function setMode($, current, mode, agentId) {
  current.modes.set(agentId ?? '', mode);
  if (mode === 'stopped' || mode === 'ended') current.epochs.set(agentId ?? '', (current.epochs.get(agentId ?? '') ?? 0) + 1);
  return rpc($, current, { op: 'state', agentId, mode });
}

async function deliver($, current, frame) {
  const epoch = current.epoch;
  const key = frame.agentId ?? '';
  const localEpoch = current.epochs.get(key);
  const available = () => !current.closed && current.epoch === epoch && current.epochs.get(key) === localEpoch && ['busy', 'idle'].includes(current.modes.get(key));
  if (!available() || !(await rpc($, current, { op: 'guard', token: frame.token })).ok || !available()) {
    await rpc($, current, { op: 'settle', token: frame.token, kind: 'released' });
    return;
  }
  // No await separates the last native-state fence from the chosen native call.
  if (current.modes.get(key) === 'busy') {
    const result = await $.session.append({ agentId: frame.agentId, message: { type: 'user', content: [{ type: 'text', text: frame.text }] } });
    if (result.deny) {
      await rpc($, current, { op: 'settle', token: frame.token, kind: 'failed' });
      $.ui.log('Square context was refused: ' + result.deny, { to: 'debug' });
      return;
    }
    const blocks = result.message?.content;
    const text = Array.isArray(blocks) && blocks.every(block => block.type === 'text' && typeof block.text === 'string')
      ? blocks.map(block => block.text).join('') : undefined;
    // Display is a separate effect, never evidence that the model read the row.
    try { $.ui.log(frame.display); } finally {
      await rpc($, current, { op: 'settle', token: frame.token, kind: 'append', text, uuid: result.uuid });
    }
    return;
  }
  if (frame.agentId !== undefined) {
    await rpc($, current, { op: 'settle', token: frame.token, kind: 'released' });
    return;
  }
  current.modes.set('', 'busy');
  // Keep the plugin attribution. A Square notification is not human input.
  const result = await $.prompt.submit({ text: frame.text });
  if (result.drop) {
    if (result.drop.includes('the session was stopped')) await setMode($, current, 'stopped');
    else {
      current.modes.set('', 'idle');
      await rpc($, current, { op: 'settle', token: frame.token, kind: 'failed' });
    }
    $.ui.log('Square prompt was not submitted: ' + result.drop, { to: 'debug' });
    return;
  }
  await rpc($, current, { op: 'settle', token: frame.token, kind: 'submit', text: result.text });
}

async function readDeliveries($, current) {
  try {
    while (!current.closed) {
      let end;
      while ((end = current.buffer.indexOf('\n')) >= 0) {
        const line = current.buffer.slice(0, end);
        current.buffer = current.buffer.slice(end + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.type === 'delivery') {
          try { await deliver($, current, frame); }
          catch (error) {
            // An invoked append/submit may already have taken effect. Never try
            // the other path, replay it, or call a fallback host on uncertainty.
            await rpc($, current, { op: 'settle', token: frame.token, kind: 'unknown' }).catch(() => undefined);
            $.ui.log('Square delivery is uncertain: ' + String(error), { to: 'debug' });
          }
        }
      }
      if (current.closed) break;
      const chunk = await current.stream.next();
      if (chunk.done) break;
      if (chunk.value.stream === 'stdout') current.buffer += chunk.value.text;
      else $.ui.log(chunk.value.text, { to: 'debug' });
    }
  } catch (error) {
    if (!current.closed) $.ui.log('Square Claude helper stopped: ' + String(error), { to: 'debug' });
  } finally { await closeRuntime($, current); }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await ensureRuntime($);
    return next(e);
  });
  // /clear and /resume end the old session without another session.start.
  on('prompt.submit', async ($, e, next) => {
    await ensureRuntime($);
    return next(e);
  }).catch(($, e, next) => next(e));
  on('turn.start', async ($, e, next) => {
    const current = await ensureRuntime($);
    await setMode($, current, 'busy', e.agentId);
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    if (runtime && !runtime.closed) {
      if (e.agentId !== undefined) {
        if (e.isAborted) await setMode($, runtime, 'stopped', e.agentId);
        await setMode($, runtime, 'ended', e.agentId);
      } else await setMode($, runtime, e.isAborted ? 'stopped' : 'idle');
    }
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    const current = runtime;
    if (current?.sessionId === e.sessionId) await closeRuntime($, current);
    return next(e);
  });
  on('tool.call', { tool: /^mcp__plugin_square_square__/ }, async ($, e, next) => {
    let current, call;
    try {
      current = await ensureRuntime($);
      call = await rpc($, current, { op: 'mcp-begin', toolUseId: e.tool_use_id, cwd: await $.session.cwd(), agentId: e.agentId });
    } catch { return { deny: 'Square MCP call identity is unavailable; this call did not run.' }; }
    try { return await next(e); }
    finally { await rpc($, current, { op: 'mcp-end', toolUseId: e.tool_use_id, token: call.token }).catch(() => undefined); }
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'Square MCP call identity is unavailable; this call did not run.' });
}
