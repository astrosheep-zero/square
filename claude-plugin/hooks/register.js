// Claude Code 2.1.295 mod. No Node imports, shell interpolation, or child credentials.
const hasToken = (text) => typeof text === 'string' && /(?:^|\n)\[square-inbox:[a-zA-Z0-9-]+\](?:\n|$)/.test(text);

async function coordinate($) {
  return { sessionId: await $.session.id(), cwd: await $.session.cwd(), version: (await $.session.version()).version, endpoint: await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET') };
}
async function bridge($, value, budget = 2800) {
  const result = await $.process.run(['square', 'claude-mod'], { cwd: value.cwd, stdin: JSON.stringify(value), timeoutMs: Math.max(1, Math.min(2800, budget)) });
  if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('Square native inbox bridge unavailable');
  return JSON.parse(result.stdout);
}
async function snapshot($, id) { return (await $.state.get({ plugin: 'square', key: 'inbox', id })).value; }
async function cancellation($, id) { return (await $.state.get({ plugin: 'square', key: 'cancelAt', id })).value; }
function confirmLater($, c, operation, text) {
  // State reads are dispatch snapshots. This ONE fresh timer dispatch is not polling.
  // Reload cancels it; lost evidence stays unknown and is never blindly replayed.
  try { $.clock.after(0, () => {
    (async () => {
      if (await $.session.id() !== c.sessionId) return;
      const old = await snapshot($, c.sessionId);
      const cancelled = await cancellation($, c.sessionId);
      await bridge($, { ...c, cancelAt: cancelled?.at, cancelledBindings: cancelled?.bindings, bindings: old?.bindings, operation, text });
    })().catch(() => undefined);
  }); } catch { /* denied scheduling leaves evidence unknown, never a second next */ }
}
async function save($, id, update, version) {
  return $.state.set({ plugin: 'square', key: 'inbox', id }, update, version === undefined ? undefined : { ifVersion: version });
}
async function reconcile($, sessionId, operation = 'start', resume = false) {
  const read = await coordinate($);
  const c = sessionId ? { ...read, sessionId } : read;
  const held = await $.state.get({ plugin: 'square', key: 'inbox', id: c.sessionId });
  const old = held.value;
  const cancelled = await cancellation($, c.sessionId);
  const result = await bridge($, { ...c, operation, cancelAt: cancelled?.at, cancelledBindings: cancelled?.bindings, bindings: old?.bindings, resume });
  // A concurrent abort must win over a stale reconciliation write.
  await save($, c.sessionId, { coordinate: c, bindings: result.bindings }, held.version);
  if (!result.available) await $.ui.log(result.diagnostic);
}

async function cancel($) {
  const c = await coordinate($);
  const old = await snapshot($, c.sessionId);
  const cancelAt = await $.clock.now();
  const captured = old?.bindings ?? [];
  await $.state.set({ plugin: 'square', key: 'cancelAt', id: c.sessionId }, { at: cancelAt, bindings: captured });
  const result = await bridge($, { ...c, bindings: captured, cancelAt, cancelledBindings: captured, operation: 'cancel' });
  try { $.clock.after(0, () => {
    (async () => {
      const held = await $.state.get({ plugin: 'square', key: 'cancelAt', id: c.sessionId });
      if (held.value?.at === cancelAt) await $.state.set({ plugin: 'square', key: 'cancelAt', id: c.sessionId }, { at: cancelAt, bindings: result.cancelledBindings }, { ifVersion: held.version });
    })().catch(() => undefined);
  }); } catch { /* captured cancellation remains engine-owned */ }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await reconcile($).catch(() => undefined);
    return next(e);
  });
  on('classic.SessionStart', async ($, e, next) => {
    await reconcile($, e.session_id, 'start', e.source === 'resume').catch(() => undefined);
    return next(e);
  });
  on('tool.call', async ($, e, next) => {
    try { return await next(e); }
    finally { if (!e.agentId) await reconcile($, undefined, 'reconcile').catch(() => undefined); }
  });
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await reconcile($, undefined, 'reconcile').catch(() => undefined);
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    // Pinned old ID and captured ownership epochs, never a later current coordinate.
    const endedAt = await $.clock.now().catch(() => undefined);
    const held = await $.state.get({ plugin: 'square', key: 'inbox', id: e.sessionId }).catch(() => undefined);
    const old = held?.value;
    const c = old?.coordinate ?? await coordinate($).catch(() => undefined);
    if (c) {
      const result = await bridge($, { ...c, sessionId: e.sessionId, bindings: old?.bindings, endedAt, operation: 'end' }, next.budget.remainingMs).catch(() => undefined);
      // Retired membership lives in the host ledger; conversation state may be cleared.
      if (result) await save($, e.sessionId, { coordinate: { ...c, sessionId: e.sessionId }, bindings: [] }, held?.version).catch(() => undefined);
    }
    return next(e);
  });
  on('turn.abort', async ($, e, next) => {
    await cancel($).catch(() => undefined);
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    // Terminal Esc aborts are reported here, not through the plugin's turn.abort op.
    if (!e.agentId && e.reason === 'aborted') await cancel($).catch(() => undefined);
    return next(e);
  });
  on('session.receive', async ($, e, next) => {
    if (e.agentId || e.origin?.kind !== 'peer' || !hasToken(e.text)) return next(e);
    const c = await coordinate($).catch(() => undefined);
    if (!c) return next(e);
    const old = await snapshot($, c.sessionId).catch(() => undefined);
    const cancelled = await cancellation($, c.sessionId).catch(() => undefined);
    const guard = await bridge($, { ...c, cancelAt: cancelled?.at, cancelledBindings: cancelled?.bindings, bindings: old?.bindings, operation: 'guard', text: e.text }).catch(() => undefined);
    if (guard?.recognized && !guard.current) return { consumed: 'Square delivery is stale or cancelled' };
    // Preserve native policy: hold/refuse reject this gate; never call next twice.
    const result = await next(e);
    if (guard?.current && result.text === e.text) confirmLater($, c, 'admitted', result.text);
    return result;
  });
  on('session.append', async ($, e, next) => {
    if (e.agentId || e.origin?.kind !== 'peer') return next(e);
    const c = await coordinate($).catch(() => undefined);
    const result = await next(e);
    if (!c || result.message?.role !== 'user') return result;
    // Match a complete payload inside one returned stored text block, not entry text.
    for (const block of result.message.content ?? []) {
      if (block.type === 'text' && hasToken(block.text)) confirmLater($, c, 'stored', block.text);
    }
    return result;
  });
}
