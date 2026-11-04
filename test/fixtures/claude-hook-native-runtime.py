"""End-to-end Claude 2.x native hooks against an isolated dummy API."""
import hashlib
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import threading
import time
from claude_runtime import Fixture

REPO, EVIDENCE, BINARY, NODE = map(pathlib.Path, sys.argv[1:5])
ROOT = EVIDENCE / 'idle-rewake'
fixture = Fixture(REPO, ROOT, NODE)
busy = threading.Event()


def reply(data):
    messages = json.dumps(data.get('messages', []))
    if 'Slow prompt before Escape.' in messages and '<session>' not in messages and not busy.is_set():
        busy.set()
        time.sleep(7)
    return {'type': 'text', 'text': 'FIXTURE_REPLY'}


def records(name):
    return fixture.records(name)


def events(event):
    return [row['input'] for row in records('invocations.jsonl')
            if row.get('input', {}).get('hook_event_name') == event]


def wait_for(predicate, label, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and fixture.process.poll() is None:
        fixture.read()
        if predicate():
            return
        time.sleep(.05)
    raise AssertionError('Timed out waiting for ' + label)


def driver(session, operation='inspect'):
    script = REPO / 'test/fixtures/claude-hook-runtime-driver.mjs'
    run = subprocess.run([str(NODE), '--import', str(REPO / 'test/sandbox-env.js'), str(script), str(ROOT), operation, session],
                         capture_output=True, text=True, env=fixture.env, timeout=15)
    if run.returncode:
        raise AssertionError(run.stderr)
    return json.loads(run.stdout)


def post_card(session, key, body):
    script = REPO / 'test/fixtures/claude-hook-runtime-driver.mjs'
    run = subprocess.run([str(NODE), '--import', str(REPO / 'test/sandbox-env.js'), str(script), str(ROOT), 'post', session, key, body],
                         capture_output=True, text=True, env=fixture.env, timeout=15)
    if run.returncode:
        raise AssertionError(run.stderr)
    return json.loads(run.stdout)


def request_has(text):
    api = json.loads((ROOT / 'api.json').read_text()) if (ROOT / 'api.json').exists() else []
    return [row for row in api if text in json.dumps(row['data'].get('messages', []))]


assert sys.platform == 'darwin', 'Native validation is empirically limited to macOS.'
version = subprocess.run([str(BINARY), '--version'], capture_output=True, text=True, timeout=10)
assert version.returncode == 0 and '2.1.299' in version.stdout, version.stdout + version.stderr
args = fixture.command(BINARY) + ['--strict-mcp-config', '--tools', '']
started = time.monotonic()
with fixture.run(args, reply):
    wait_for(lambda: bool(events('SessionStart')), 'native SessionStart')
    start = events('SessionStart')[0]
    session = start['session_id']
    owner = 'claude-code:' + session
    os.write(fixture.master, b'Initial native hook prompt.\r')
    wait_for(lambda: any(row.get('prompt') == 'Initial native hook prompt.' for row in events('UserPromptSubmit')),
             'prompt id capture')
    wait_for(lambda: bool(events('Stop')), 'first normal Stop hook')
    first_stop = events('Stop')[-1]
    assert first_stop['prompt_id'] == events('UserPromptSubmit')[-1]['prompt_id']
    watch_lock = ROOT / 'claude-hooks' / (hashlib.sha256(session.encode()).hexdigest() + '.watch.lock')
    def watcher_locked():
        if not watch_lock.exists():
            return False
        connection = sqlite3.connect(watch_lock, timeout=0)
        try:
            connection.execute('BEGIN EXCLUSIVE')
            connection.rollback()
            return False
        except sqlite3.OperationalError as error:
            assert 'locked' in str(error), str(error)
            return True
        finally:
            connection.close()
    wait_for(watcher_locked, 'actual native Stop singleton lock')
    duplicate = subprocess.Popen([str(ROOT / 'bin/square'), 'claude-watch'], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=fixture.env)
    duplicate.stdin.write(json.dumps(first_stop))
    duplicate.stdin.close()
    duplicate.stdin = None

    post_card(session, 'notice:idle-one', 'NATIVE_IDLE_NOTICE_ONE')
    wait_for(lambda: bool(request_has('NATIVE_IDLE_NOTICE_ONE')), 'first idle asyncRewake with no human follow-up')
    wait_for(lambda: any(event.get('prompt', '').find('square-delivery:') >= 0 for event in events('UserPromptSubmit')),
             'native receipt prompt for first stop frame')
    state = driver(session)
    assert any(item['key'] == 'notice:idle-one' for item in state['receipts']), 'exact native token frame was not confirmed'
    duplicate_out, duplicate_err = duplicate.communicate(timeout=5)
    assert duplicate.returncode == 0 and not duplicate_out and not duplicate_err, (duplicate.returncode, duplicate_out, duplicate_err)
    (ROOT / 'duplicate-stop.json').write_text(json.dumps({'input': first_stop, 'exit': duplicate.returncode,
                                                        'stdout': duplicate_out, 'stderr': duplicate_err}))
    wait_for(lambda: any(row.get('stop_hook_active') is True for row in events('Stop')),
             'generated completion Stop with stop_hook_active=true')

    post_card(session, 'notice:idle-two', 'NATIVE_IDLE_NOTICE_TWO')
    wait_for(lambda: bool(request_has('NATIVE_IDLE_NOTICE_TWO')), 'second idle notice after generated Stop, without another human prompt')
    human_prompts = [row for row in events('UserPromptSubmit') if row.get('prompt') in ['Initial native hook prompt.', 'Active boundary prompt.', 'Slow prompt before Escape.', 'Recover pending notification.']]
    assert [row['prompt'] for row in human_prompts] == ['Initial native hook prompt.'], human_prompts

    wait_for(lambda: len(events('Stop')) >= 3, 'second generated normal Stop')
    os.write(fixture.master, b'Slow prompt before Escape.\r')
    wait_for(lambda: busy.is_set(), 'slow model request')
    post_card(session, 'notice:cancel-fence', 'NATIVE_CANCEL_FENCE_NOTICE')
    os.write(fixture.master, b'\x1b')
    wait_for(lambda: (ROOT / 'debug.log').exists() and 'Request was aborted.' in (ROOT / 'debug.log').read_text(),
             'actual busy-turn Escape abort')
    time.sleep(1.5)
    assert not request_has('NATIVE_CANCEL_FENCE_NOTICE'), 'old Stop watcher crossed the new prompt fence'
    assert any(item['key'] == 'notice:cancel-fence' for item in driver(session)['pending'])

    os.write(fixture.master, b'\x15Recover pending notification.\r')
    wait_for(lambda: bool(request_has('NATIVE_CANCEL_FENCE_NOTICE')), 'pending card at next active prompt after busy Escape')
    active_hook = next(row for row in records('bridge.jsonl')
                       if row['input'].get('hook_event_name') == 'UserPromptSubmit'
                       and row['input'].get('prompt') == 'Recover pending notification.')
    active_output = json.loads(active_hook['stdout'])
    assert active_output['hookSpecificOutput']['hookEventName'] == 'UserPromptSubmit'
    assert 'NATIVE_CANCEL_FENCE_NOTICE' in active_output['hookSpecificOutput']['additionalContext']
    final_state = driver(session)
    assert any(row['key'] == 'notice:cancel-fence' for row in final_state['receipts'])
    assert final_state['session']['state'] == 'attached'
    assert [route['kind'] for route in final_state['session']['routes']] == ['claude-async-hook']

    # Re-deliver a captured native SessionStart input through the same shipped
    # scratch CLI to exercise attachment rotation while the real Stop observer waits.
    rotation_script = f"""import {{spawnSync}} from 'node:child_process';
const input={json.dumps(start)};
const run=spawnSync({json.dumps(str(ROOT / 'bin/square'))},['claude-hook'],{{input:JSON.stringify({{...input,hook_event_name:'SessionStart'}}),encoding:'utf8',env:process.env}});
if(run.status!==0) throw new Error(run.stderr);
"""
    rotate = subprocess.run([str(NODE), '--input-type=module', '-e', rotation_script], capture_output=True, text=True,
                            env=fixture.env, cwd=ROOT, timeout=15)
    assert rotate.returncode == 0, rotate.stderr
    rotated = driver(session)
    assert rotated['session']['generation'] != final_state['session']['generation']
    post_card(session, 'notice:rotation-fence', 'NATIVE_ROTATION_FENCE_NOTICE')
    time.sleep(1.5)
    assert not request_has('NATIVE_ROTATION_FENCE_NOTICE'), 'old attachment observer survived generation rotation'

    manifest = json.loads((ROOT / 'plugin/hooks/hooks.json').read_text())
    assert manifest['hooks']['Stop'][0]['hooks'][0]['asyncRewake'] is True
    assert manifest['hooks']['Stop'][0]['hooks'][0]['timeout'] == 86400
    assert 'async' not in manifest['hooks']['Stop'][0]['hooks'][0]
    for filename in ['hooks/hooks.json', '.mcp.json', '.claude-plugin/plugin.json']:
        assert (ROOT / 'plugin' / filename).read_bytes() == (REPO / 'plugins/claude' / filename).read_bytes()

summary = {
    'runtime': version.stdout.strip(), 'sessionId': session, 'owner': owner,
    'wallSeconds': round(time.monotonic() - started, 2),
    'idleNoticesWokeWithoutHumanInput': 2,
    'secondGeneratedStopHadStopHookActive': True,
    'activeBoundaryContext': True, 'busyEscapeFencedOldWatcher': True,
    'nativeFrameReceiptObserved': True, 'attachmentRotationFenced': True, 'duplicateStopSuppressed': True,
    'apiRequests': len(json.loads((ROOT / 'api.json').read_text())),
    'hookInvocations': len(records('invocations.jsonl')),
    'candidateCli': str(REPO / 'dist/square.js'), 'plugin': str(ROOT / 'plugin'),
}
(ROOT / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
