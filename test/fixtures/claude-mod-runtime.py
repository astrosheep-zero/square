"""Isolated real-Claude mod delivery: no external model or installed runtime changes."""
import http.server
import json
import os
import pathlib
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import uuid

REPO, ROOT, BINARY, NODE = map(str, sys.argv[1:5])
REPO, ROOT = pathlib.Path(REPO), pathlib.Path(ROOT).resolve()
for name in ['home', 'config', 'work', 'bin']:
    (ROOT / name).mkdir(parents=True, exist_ok=True)
shutil.copytree(REPO / 'plugins/claude', ROOT / 'plugin')
SESSION = str(uuid.uuid4())
config = {'hasCompletedOnboarding': True, 'theme': 'dark',
          'customApiKeyResponses': {'approved': ['ure-not-a-credential'], 'rejected': []},
          'projects': {str(ROOT / 'work'): {'hasTrustDialogAccepted': True}}}
for name in ['home/.claude.json', 'config/.claude.json']:
    (ROOT / name).write_text(json.dumps(config))
(ROOT / 'settings.json').write_text('{}')
(ROOT / 'empty-mcp.json').write_text('{"mcpServers":{}}')
(ROOT / 'bin/square').write_text('#!/bin/sh\nexec ' + json.dumps(NODE) + ' ' + json.dumps(str(REPO / 'dist/square.js')) + ' "$@"\n')
(ROOT / 'bin/square').chmod(0o755)
state = {'phase': 'boot', 'toolSent': False}
calls, frames, errors = [], [], []
condition = threading.Condition()


def driver(command, key='', text=''):
    run = subprocess.run([NODE, str(REPO / 'test/fixtures/claude-mod-runtime-driver.mjs'), str(ROOT), command, SESSION, key, text],
                         capture_output=True, text=True, timeout=10)
    if run.returncode:
        raise RuntimeError(run.stderr)
    return json.loads(run.stdout)


def post_busy():
    time.sleep(0.15)
    driver('post', 'busy-notice', 'SQUARE_MOD_BUSY_NOTICE')


def sse(data, block, index):
    tool = block['type'] == 'tool_use'
    stop = 'tool_use' if tool else 'end_turn'
    base = {'id': 'msg_mod_' + str(index), 'type': 'message', 'role': 'assistant', 'model': data.get('model'),
            'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 0}}
    start = {**block, 'input': {}} if tool else {'type': 'text', 'text': ''}
    delta = {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])} if tool else {'type': 'text_delta', 'text': block['text']}
    events = [('message_start', {'message': base}), ('content_block_start', {'index': 0, 'content_block': start}),
              ('content_block_delta', {'index': 0, 'delta': delta}), ('content_block_stop', {'index': 0}),
              ('message_delta', {'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': 10}}), ('message_stop', {})]
    return ''.join('event: ' + name + '\ndata: ' + json.dumps({'type': name, **value}) + '\n\n' for name, value in events).encode()


class Server(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
        if 'count_tokens' in self.path:
            self.send_response(200); self.end_headers(); self.wfile.write(b'{"input_tokens":10}'); return
        with condition:
            phase = state['phase']
            calls.append({'phase': phase, 'data': data})
            (ROOT / 'api.json').write_text(json.dumps(calls))
            index = len(calls)
            tool = phase in ['busy', 'interrupt'] and not state['toolSent']
            if tool:
                state['toolSent'] = True
            condition.notify_all()
        if tool:
            command = 'sleep 1; printf ORIGINAL_BUSY_OUTPUT' if phase == 'busy' else 'sleep 10; printf ORIGINAL_INTERRUPT_OUTPUT'
            block = {'type': 'tool_use', 'id': 'toolu_mod_' + phase, 'name': 'Bash', 'input': {'command': command, 'description': 'Isolated mod fixture'}}
        else:
            block = {'type': 'text', 'text': phase.upper() + '_DONE'}
        self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.end_headers()
        self.wfile.write(sse(data, block, index))
        if phase == 'busy' and tool:
            threading.Thread(target=post_busy, daemon=True).start()


def wait(check, timeout=15):
    deadline = time.monotonic() + timeout
    with condition:
        while not check():
            if time.monotonic() > deadline:
                raise RuntimeError('Native mod condition timed out: ' + json.dumps({'phase': state, 'frames': frames[-8:], 'stderr': errors[-8:]}))
            condition.wait(0.05)


def results():
    return [frame for frame in frames if frame.get('type') == 'result']


def send(text):
    proc.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': text}, 'parent_tool_use_id': None}) + '\n')
    proc.stdin.flush()


summary = {'sessionId': SESSION}
with socketserver.ThreadingTCPServer(('127.0.0.1', 0), Server) as server:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {key: value for key, value in os.environ.items() if key in ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME']}
    env.update(HOME=str(ROOT / 'home'), CLAUDE_CONFIG_DIR=str(ROOT / 'config'), TMPDIR=str(ROOT),
               PATH=str(ROOT / 'bin') + os.pathsep + env.get('PATH', ''),
               ANTHROPIC_API_KEY='sk-ant-dummy-fixture-not-a-credential',
               ANTHROPIC_BASE_URL='http://127.0.0.1:' + str(server.server_address[1]),
               CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', ENABLE_TOOL_SEARCH='false',
               SQUARE_DELIVERY=str(ROOT / 'delivery.sqlite'))
    args = [BINARY, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
            '--include-partial-messages', '--replay-user-messages', '--session-id', SESSION,
            '--setting-sources', '', '--settings', str(ROOT / 'settings.json'),
            '--mcp-config', str(ROOT / 'empty-mcp.json'), '--strict-mcp-config', '--model', 'claude-sonnet-4-6',
            '--debug-file', str(ROOT / 'debug.log'), '--permission-mode', 'bypassPermissions', '--plugin-dir', str(ROOT / 'plugin')]
    proc = subprocess.Popen(args, cwd=ROOT / 'work', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def stdout():
        for line in proc.stdout:
            with (ROOT / 'stdout.jsonl').open('a') as log:
                log.write(line)
            try:
                frame = json.loads(line)
            except Exception:
                continue
            with condition:
                frames.append(frame)
                condition.notify_all()

    def stderr():
        for line in proc.stderr:
            errors.append(line)

    readers = [threading.Thread(target=stdout), threading.Thread(target=stderr)]
    for reader in readers:
        reader.start()
    try:
        send('BOOT')
        wait(lambda: len(results()) == 1)
        assert not results()[0].get('is_error')
        for n in [1, 2]:
            state.update(phase='idle-' + str(n), toolSent=False)
            assert driver('post', 'idle-' + str(n), 'SQUARE_MOD_IDLE_NOTICE_' + str(n))['status'] == 'posted'
            wait(lambda: len(results()) == n + 1)
            assert 'SQUARE_MOD_IDLE_NOTICE_' + str(n) in json.dumps(calls[-1]['data']['messages'])
            assert results()[-1].get('origin') == {'kind': 'plugin', 'name': 'square'}
            assert not results()[-1].get('is_error')
        count = len(calls)
        driver('post', 'idle-2', 'SQUARE_MOD_IDLE_NOTICE_2')
        time.sleep(0.2)
        assert len(calls) == count
        summary['idleWakes'] = 2
        summary['duplicateSuppressed'] = True
        state.update(phase='busy', toolSent=False)
        send('BUSY_PROBE')
        wait(lambda: len(results()) == 4)
        assert not results()[-1].get('is_error')
        busy = [call for call in calls if call['phase'] == 'busy']
        assert len(busy) == 2
        assert 'SQUARE_MOD_BUSY_NOTICE' not in json.dumps(busy[0]['data']['messages'])
        assert 'SQUARE_MOD_BUSY_NOTICE' in json.dumps(busy[1]['data']['messages'])
        assert any(frame.get('subtype') == 'ui_log' and frame.get('text') == 'SQUARE_MOD_BUSY_NOTICE' for frame in frames)
        summary['busyAppendedWithinTurn'] = True
        summary['busyUiLogEmitted'] = True
        state.update(phase='interrupt', toolSent=False)
        send('INTERRUPT_PROBE')
        wait(lambda: any(frame.get('type') == 'assistant' and 'toolu_mod_interrupt' in json.dumps(frame) for frame in frames))
        proc.stdin.write(json.dumps({'type': 'control_request', 'request_id': 'fixture-stop', 'request': {'subtype': 'interrupt'}}) + '\n')
        proc.stdin.flush()
        wait(lambda: len(results()) == 5)
        interrupted = results()[-1]
        assert interrupted.get('terminal_reason') == 'aborted_tools'
        assert interrupted.get('is_error') and interrupted.get('subtype') == 'error_during_execution'
        summary['expectedInterrupt'] = True
        count = len(calls)
        driver('post', 'after-stop', 'SQUARE_MOD_MUST_NOT_WAKE_AFTER_STOP')
        time.sleep(0.5)
        assert len(calls) == count
        assert not any(frame.get('subtype') == 'ui_log' and 'SQUARE_MOD_MUST_NOT_WAKE_AFTER_STOP' in frame.get('text', '') for frame in frames)
        summary['stopDidNotWakeOrAppend'] = True
        inspection = driver('inspect')
        (ROOT / 'ledger-before-close.json').write_text(json.dumps(inspection, indent=2))
        assert {row['key'] for row in inspection['receipts']} == {'idle-1', 'idle-2', 'busy-notice'}
        summary['exactReceipts'] = True
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait()
        for reader in readers:
            reader.join()
        (ROOT / 'stderr.log').write_text(''.join(errors))
        server.shutdown()
summary['exit'] = proc.returncode
assert proc.returncode == 1, 'Only the deliberately aborted tool may fail the native run'
summary['detachedOnExit'] = driver('inspect')['session']['state'] == 'detached'
assert summary['detachedOnExit']
(ROOT / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary))
