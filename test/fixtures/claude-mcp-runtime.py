"""Main/child MCP identity through the shipped Claude native hooks."""
import json
import os
import pathlib
import signal
import subprocess
import sys
import time
from claude_runtime import Fixture

REPO, R, BINARY, NODE = map(pathlib.Path, sys.argv[1:5])
fixture = Fixture(REPO, R, NODE)
stages = set()


def reply(data):
    names = [tool['name'] for tool in data.get('tools', [])]
    messages = json.dumps(data.get('messages', []))
    child = 'CHILD_MCP_FIXTURE' in messages and 'toolu_fixture_agent' not in messages
    join = next((name for name in names if name == 'mcp__plugin_square_square__join'), None)
    if join:
        key = 'child' if child else 'main'
        if key not in stages:
            stages.add(key)
            return {'type': 'tool_use', 'id': f'toolu_fixture_{key}', 'name': join,
                    'input': {'location': 'test.square', 'as': key}}
        if not child and 'main' in stages:
            agent = next((name for name in names if name in ['Agent', 'Task']), None)
            if agent and 'agent' not in stages:
                stages.add('agent')
                session = next(row['input']['session_id'] for row in fixture.records('invocations.jsonl')
                               if row.get('input', {}).get('hook_event_name') == 'SessionStart')
                posted = subprocess.run([str(NODE), '--import', str(REPO / 'test/sandbox-env.js'),
                    str(REPO / 'test/fixtures/claude-hook-runtime-driver.mjs'), str(R), 'post', session,
                    'notice:tool-boundary', 'NATIVE_DURING_TURN_TOOL_NOTICE'], capture_output=True, text=True, env=fixture.env, timeout=10)
                assert posted.returncode == 0, posted.stderr
                return {'type': 'tool_use', 'id': 'toolu_fixture_agent', 'name': agent, 'input': {
                    'description': 'Check child MCP ownership', 'subagent_type': 'general-purpose',
                    'prompt': 'CHILD_MCP_FIXTURE: join test.square as child, then finish.'}}
            if not child and 'agent' in stages and 'collision' not in stages:
                stages.add('collision')
                seeded = subprocess.run([str(NODE), '--import', str(REPO / 'test/sandbox-env.js'),
                    str(REPO / 'test/fixtures/claude-hook-runtime-driver.mjs'), str(R), 'seed-call', 'foreign-session',
                    'toolu_fixture_collision'], capture_output=True, text=True, env=fixture.env, timeout=10)
                assert seeded.returncode == 0, seeded.stderr
                return {'type': 'tool_use', 'id': 'toolu_fixture_collision', 'name': join,
                        'input': {'location': 'test.square', 'as': 'must-not-join'}}
    return {'type': 'text', 'text': 'FIXTURE_COMPLETE'}


args = fixture.command(BINARY) + ['--permission-mode', 'default', '--tools', 'Agent',
                                '--allowedTools', 'Agent(general-purpose),mcp__plugin_square_square__join']
sent, complete = False, False
beg = time.monotonic()


def timeout(signum, frame):
    raise TimeoutError('Claude MCP fixture exceeded 70s hard deadline')


signal.signal(signal.SIGALRM, timeout)
signal.alarm(70)
try:
    with fixture.run(args, reply):
        while time.monotonic() - beg < 60 and fixture.process.poll() is None:
            if not fixture.read():
                break
            invocations = fixture.records('invocations.jsonl')
            if not sent and any(row.get('input', {}).get('hook_event_name') == 'SessionStart' for row in invocations):
                if not any(row.get('method') == 'tools/list' for row in fixture.records('mcp-in.jsonl')):
                    continue
                time.sleep(1)
                os.write(fixture.master, b'Join test.square as main, then run the child MCP ownership fixture.')
                time.sleep(.3)
                os.write(fixture.master, b'\r')
                sent = True
            terminal = {row.get('input', {}).get('tool_use_id') for row in invocations
                        if row.get('input', {}).get('hook_event_name') in ['PostToolUse', 'PostToolUseFailure']}
            denied = any(row.get('input', {}).get('tool_use_id') == 'toolu_fixture_collision'
                         and 'permissionDecision' in row.get('stdout', '') and 'deny' in row['stdout']
                         for row in fixture.records('bridge.jsonl'))
            denied_observed = any('Square MCP call identity is unavailable' in json.dumps(call['data'].get('messages', []))
                                  for call in fixture.calls)
            if {'toolu_fixture_main', 'toolu_fixture_child'} <= terminal and denied and denied_observed:
                complete = True
                break
finally:
    signal.alarm(0)
assert complete, 'No completed main/child calls; inspect ' + str(R)
(R / 'summary.json').write_text(json.dumps({'mainChildToolHooksCompleted': True, 'toolNamespaced': 'mcp__plugin_square_square__join'}) + '\n')
print(json.dumps({'evidence': str(R), 'mainChildToolHooksCompleted': complete}))
