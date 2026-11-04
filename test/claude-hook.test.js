import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runClaudeHook, runClaudeWatch } from '../dist/claude-hook.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { renderDeliveryReminder } from '../dist/delivery-frame.js';
import { harnessOwner } from '../dist/owner.js';
import { readClaudeMcpCall } from '../dist/claude-mcp-context.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-claude-hook-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { SQUARE_DELIVERY: path.join(root, 'delivery.sqlite') };
  const sessionId = 'native-session';
  const owner = harnessOwner({ channel: 'claude-code', session: sessionId });
  await runClaudeHook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId }), env);
  return { root, env, sessionId, owner };
}

function cardFrame(token, body) {
  return renderDeliveryReminder([`[square-delivery:${token}]\n${body}\n[/square-delivery:${token}]`], { tagged: false });
}

async function nativeHandoff(ledger, owner, key, text) {
  let frame;
  const transport = {
    kind: 'claude-async-hook',
    async send(card, _address, context) {
      frame = cardFrame(context.token, card.text);
      assert.equal(await context.prepare({
        token: context.token,
        messageId: context.token,
        payloadHash: createHash('sha256').update(frame).digest('hex'),
      }), true);
      return 'unknown';
    },
  };
  const session = await ledger.session(owner);
  await ledger.post({ owner, key, text });
  const result = await ledger.dispatchHandoff(owner, key, transport, { generation: session.generation, timeoutMs: 1000 });
  assert.equal(result.outcome, 'unknown');
  return { frame, token: result.token };
}

test('native exact frame observation confirms the correlated unknown handoff without a pre-effect guard', async t => {
  const { env, owner, sessionId } = await fixture(t);
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  try {
    const observed = await nativeHandoff(ledger, owner, 'notice:exact', 'full card body');
    assert.equal((await ledger.receipts(owner)).length, 0);
    await runClaudeHook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId }), env);
    await runClaudeHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId,
      prompt_id: 'prompt-after-wake', prompt: observed.frame }), env, async () => {});
    assert.deepEqual((await ledger.receipts(owner)).map(receipt => receipt.key), ['notice:exact']);

    const changed = await nativeHandoff(ledger, owner, 'notice:changed', 'another full card');
    await runClaudeHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId,
      prompt_id: 'later-prompt', prompt: changed.frame.replace('another full card', 'changed card') }), env, async () => {});
    await runClaudeHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId,
      prompt_id: 'truncated-frame', prompt: changed.frame.slice(0, -1) }), env, async () => {});
    await runClaudeHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'foreign-native-session',
      prompt_id: 'foreign-frame', prompt: changed.frame }), env, async () => {});
    assert.deepEqual((await ledger.receipts(owner)).map(receipt => receipt.key), ['notice:exact']);
    // Actual native hook input wraps the emitted plain frame; the complete
    // token-delimited bytes, including warning and trailing whitespace, are exact.
    await runClaudeHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId,
      prompt_id: 'native-wrapped-frame', prompt: `<task-notification>\n</task-notification>\n<system-reminder>\nStop hook blocking error: ${changed.frame}\n</system-reminder>` }), env, async () => {});
    assert.deepEqual((await ledger.receipts(owner)).map(receipt => receipt.key).sort(), ['notice:changed', 'notice:exact']);
  } finally { await ledger.close(); }
});

test('prompt without native id disarms its prior Stop and stale Stop fails closed', async t => {
  const { env, sessionId } = await fixture(t);
  const stateFile = path.join(path.dirname(env.SQUARE_DELIVERY), 'claude-hooks',
    `${createHash('sha256').update(sessionId).digest('hex')}.json`);
  await runClaudeHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt_id: 'current-prompt' }), env, async () => {});
  const before = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  await runClaudeHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId }), env, async () => {});
  const after = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.notEqual(after.stopEpoch, before.stopEpoch);
  assert.equal(after.promptId, undefined);
  assert.equal(await runClaudeWatch(JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, prompt_id: 'current-prompt' }), env), '');
  await runClaudeHook(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sessionId }), env);
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  try { assert.equal((await ledger.session(harnessOwner({ channel: 'claude-code', session: sessionId }))).state, 'detached'); }
  finally { await ledger.close(); }
});

test('tool hooks separate MCP identity from PostToolUse delivery, including failure cleanup', async t => {
  const { env, sessionId, owner } = await fixture(t);
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  t.after(() => ledger.close());
  const tool = { session_id: sessionId, cwd: '/native cwd',
    tool_name: 'mcp__plugin_square_square__join', tool_use_id: 'toolu-success' };
  const hook = (event, input = tool, sink = () => assert.fail('identity hooks must not present cards')) =>
    runClaudeHook(JSON.stringify({ ...input, hook_event_name: event }), env, sink);
  await ledger.post({ owner, key: 'success', text: 'deliver after the tool finishes' });
  await hook('PreToolUse');
  assert.equal((await readClaudeMcpCall(tool.tool_use_id, env)).sessionId, sessionId);
  let output;
  await hook('PostToolUse', tool, async text => {
    await assert.rejects(readClaudeMcpCall(tool.tool_use_id, env), { code: 'unavailable' });
    assert.deepEqual(await ledger.receipts(owner), []);
    output = JSON.parse(text);
  });
  assert.match(output.hookSpecificOutput.additionalContext, /deliver after the tool finishes/);
  assert.equal((await ledger.receipts(owner)).length, 1);

  const failed = { ...tool, tool_use_id: 'toolu-failure' };
  await ledger.post({ owner, key: 'failure', text: 'wait for a successful boundary' });
  await hook('PreToolUse', failed);
  await hook('PostToolUseFailure', failed);
  await assert.rejects(readClaudeMcpCall(failed.tool_use_id, env), { code: 'unavailable' });
  const generation = (await ledger.session(owner)).generation;
  assert.deepEqual((await ledger.pending(owner, { generation })).map(card => card.key), ['failure']);
  await hook('PostToolUse', { session_id: sessionId, tool_name: 'Bash' }, () => {});
  assert.equal((await ledger.receipts(owner)).length, 2);
});

test('MCP identity collision is denied through the hook sink and foreign terminal event cannot clear it', async t => {
  const { env, sessionId } = await fixture(t);
  const input = { hook_event_name: 'PreToolUse', session_id: sessionId, cwd: '/native cwd',
    tool_name: 'mcp__plugin_square_square__join', tool_use_id: 'toolu-duplicate' };
  await runClaudeHook(JSON.stringify(input), env, async () => {});
  const output = [];
  await runClaudeHook(JSON.stringify(input), env, async text => { output.push(text); });
  assert.equal(output.length, 1);
  const denied = JSON.parse(output[0]);
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');

  await runClaudeHook(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'other-session',
    tool_name: input.tool_name, tool_use_id: input.tool_use_id }), env, async () => {});
  assert.equal((await readClaudeMcpCall(input.tool_use_id, env)).sessionId, sessionId);
  await runClaudeHook(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: sessionId, agent_id: 'foreign-agent',
    tool_name: input.tool_name, tool_use_id: input.tool_use_id }), env, async () => {});
  assert.equal((await readClaudeMcpCall(input.tool_use_id, env)).sessionId, sessionId);
  await runClaudeHook(JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: sessionId,
    tool_name: input.tool_name, tool_use_id: input.tool_use_id }), env, async () => {});
  await assert.rejects(readClaudeMcpCall(input.tool_use_id, env), { code: 'unavailable' });
});
