"""Shared scratch configuration, loopback API and PTY for real Claude tests."""
import contextlib
import http.server
import json
import os
import pty
import select
import shutil
import signal
import socketserver
import subprocess
import sys
import threading

# Intercept only the process boundary; execute the actual candidate CLI unchanged.
SHIM = '''#!PYTHON
import json,os,pathlib,subprocess,sys,threading
R=pathlib.Path(ROOT)
cmd=[NODE,"--import",SANDBOX,ENTRY]+sys.argv[1:]
def record(name,value):
 with (R/name).open('a') as f: f.write(json.dumps(value)+'\\n')
if sys.argv[1:]==['mcp-server']:
 p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(R/'mcp-stderr.log').open('ab'))
 def incoming():
  for line in sys.stdin.buffer:
   try: record('mcp-in.jsonl',json.loads(line))
   except ValueError: pass
   p.stdin.write(line);p.stdin.flush()
  p.stdin.close()
 threading.Thread(target=incoming,daemon=True).start()
 for line in p.stdout:
  try: record('mcp-out.jsonl',json.loads(line))
  except ValueError: pass
  sys.stdout.buffer.write(line);sys.stdout.buffer.flush()
 code=p.wait()
 sys.stdout.flush();sys.stderr.flush()
 # The input pump may still be blocked; avoid interpreter teardown locks.
 os._exit(code)
value=sys.stdin.read()
p=subprocess.run(cmd,input=value,text=True,capture_output=True,timeout=12)
try: record('bridge.jsonl',{'input':json.loads(value),'stdout':p.stdout,'stderr':p.stderr,'exit':p.returncode})
except ValueError: pass
sys.stdout.write(p.stdout);sys.stderr.write(p.stderr);sys.exit(p.returncode)
'''


class Fixture:
    def __init__(self, repo, root, node=None):
        self.root = root.resolve()
        self.calls, self.log, self.lock = [], b'', threading.Lock()
        for directory in ['home', 'config', 'work', 'bin']:
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        shutil.copytree(repo / 'plugins/claude', self.root / 'plugin')
        config = {'hasCompletedOnboarding': True, 'theme': 'dark',
                  'customApiKeyResponses': {'approved': ['ure-not-a-credential'], 'rejected': []},
                  'projects': {str(self.root / 'work'): {'hasTrustDialogAccepted': True}}}
        for name in ['home/.claude.json', 'config/.claude.json']:
            (self.root / name).write_text(json.dumps(config))
        (self.root / 'settings.json').write_text('{"crossSessionInbound":"accept","autoUpdatesChannel":"stable"}')
        (self.root / 'empty-mcp.json').write_text('{"mcpServers":{}}')
        shim = SHIM.replace('PYTHON', sys.executable).replace('ROOT', repr(str(self.root)))
        shim = shim.replace('NODE', repr(str(node or shutil.which('node')))).replace('SANDBOX', repr(str(repo / 'test/sandbox-env.js'))).replace('ENTRY', repr(str(repo / 'dist/square.js')))
        (self.root / 'bin/square').write_text(shim)
        (self.root / 'bin/square').chmod(0o755)

    def records(self, name):
        file = self.root / name
        return [json.loads(line) for line in file.read_text().splitlines() if line] if file.exists() else []

    def command(self, binary):
        return [str(binary), '--setting-sources', '', '--settings', str(self.root / 'settings.json'),
                '--mcp-config', str(self.root / 'empty-mcp.json'), '--plugin-dir', str(self.root / 'plugin'),
                '--model', 'claude-sonnet-4-6', '--debug-file', str(self.root / 'debug.log')]

    def read(self):
        ready, _, _ = select.select([self.master], [], [], .15)
        if ready:
            try:
                self.log += os.read(self.master, 65536)
            except OSError:
                return False
            (self.root / 'terminal.log').write_bytes(self.log)
        return True

    @contextlib.contextmanager
    def run(self, args, reply):
        fixture = self

        class Server(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
                with fixture.lock:
                    fixture.calls.append({'path': self.path, 'data': data})
                    (fixture.root / 'api.json').write_text(json.dumps(fixture.calls))
                    mid = 'msg_fixture_' + str(len(fixture.calls))
                if 'count_tokens' in self.path:
                    self.send_response(200); self.end_headers()
                    self.wfile.write(b'{"input_tokens":10}')
                    return
                block = reply(data)
                tool = block['type'] == 'tool_use'
                stop = 'tool_use' if tool else 'end_turn'
                base = {'id': mid, 'type': 'message', 'role': 'assistant', 'model': data.get('model', 'claude-sonnet-4-6'),
                        'content': [block], 'stop_reason': stop, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 10}}
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream' if data.get('stream') else 'application/json')
                self.end_headers()
                if not data.get('stream'):
                    self.wfile.write(json.dumps(base).encode())
                    return
                start = {**block, 'input': {}} if tool else {'type': 'text', 'text': ''}
                delta = {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])} if tool else {'type': 'text_delta', 'text': block['text']}
                events = [('message_start', {'message': {**base, 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 10, 'output_tokens': 0}}}),
                          ('content_block_start', {'index': 0, 'content_block': start}),
                          ('content_block_delta', {'index': 0, 'delta': delta}),
                          ('content_block_stop', {'index': 0}),
                          ('message_delta', {'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': 10}}),
                          ('message_stop', {})]
                for name, value in events:
                    self.wfile.write(('event: ' + name + '\ndata: ' + json.dumps({'type': name, **value}) + '\n\n').encode())
                    self.wfile.flush()

        # Avoid HTTPServer's unnecessary reverse DNS lookup on this Mac.
        with socketserver.ThreadingTCPServer(('127.0.0.1', 0), Server) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.endpoint = 'http://127.0.0.1:' + str(server.server_address[1])
            env = {key: value for key, value in os.environ.items() if key in ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME']}
            env.update(HOME=str(self.root / 'home'), CLAUDE_CONFIG_DIR=str(self.root / 'config'), TMPDIR=str(self.root),
                       PATH=str(self.root / 'bin') + ':' + env['PATH'], SQUARE_HOST_LEDGER_ROOT=str(self.root / 'ledger'),
                       ANTHROPIC_API_KEY='sk-ant-dummy-fixture-not-a-credential', ANTHROPIC_BASE_URL=self.endpoint,
                       CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', TERM='xterm-256color')
            self.master, slave = pty.openpty()
            try:
                self.process = subprocess.Popen(args, cwd=self.root / 'work', env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            finally:
                os.close(slave)
            try:
                yield self
            finally:
                # Shims and real MCP processes inherit this isolated process group.
                try:
                    os.killpg(self.process.pid, signal.SIGTERM)
                    self.process.wait(timeout=3)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    pass
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=3)
                server.shutdown()
                os.close(self.master)
