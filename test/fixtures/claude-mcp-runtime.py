"""Opt-in main/child MCP scenario using the actual shipped plugin and CLI."""
import json
import os
import pathlib
import signal
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
    with fixture.lock:
        key = 'child' if child else ('agent' if 'main' in stages else 'main')
        if join and key not in stages:
            stages.add(key)
            if key != 'agent':
                return {'type': 'tool_use', 'id': 'toolu_fixture_' + key, 'name': join,
                        'input': {'location': 'test.square', 'as': key}}
            agent = next((name for name in names if name in ['Agent', 'Task']), None)
            if agent:
                return {'type': 'tool_use', 'id': 'toolu_fixture_agent', 'name': agent, 'input': {
                    'description': 'Check child MCP ownership', 'subagent_type': 'general-purpose',
                    'prompt': 'CHILD_MCP_FIXTURE: join test.square as child, then finish.'}}
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
            bridges = fixture.records('bridge.jsonl')
            if not sent and any(row['input'].get('operation') == 'start' for row in bridges):
                # Let plugin MCP discovery finish before the first synthetic request.
                if not any(row.get('method') == 'tools/list' for row in fixture.records('mcp-in.jsonl')):
                    continue
                time.sleep(1)
                os.write(fixture.master, b'Join test.square as main, then run the child MCP ownership fixture.')
                time.sleep(.3)
                os.write(fixture.master, b'\r')
                sent = True
            ended = {row['input'].get('toolUseId') for row in bridges if row['input'].get('operation') == 'tool-end' and row['exit'] == 0}
            if {'toolu_fixture_main', 'toolu_fixture_child'} <= ended:
                complete = True
                break
finally:
    signal.alarm(0)
assert complete, 'No completed main/child calls; inspect ' + str(R)
