// Test processes must not inherit a live harness session, the real square
// registry or a real Paseo daemon: library calls read the ambient environment.
// A real PI_SESSION_ID would bind participants to the session running the suite.
// Loaded via `node --import`, so it runs in every test child process before the
// test file itself. Spawned CLI children override these variables via testEnv.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'square-test-env-'));
const paseoHome = path.join(state, 'paseo');
fs.mkdirSync(paseoHome);

// An absent IPC socket prevents fallback to a real daemon's default TCP port.
process.env.PASEO_HOME = paseoHome;
process.env.PASEO_HOST = `unix://${path.join(paseoHome, 'daemon.sock')}`;
delete process.env.PASEO_PASSWORD;

process.env.PI_SESSION_ID = '';
process.env.CLAUDE_CODE_SESSION_ID = '';
process.env.CLAUDE_CODE_CHILD_SESSION = '';
process.env.CODEX_THREAD_ID = '';
process.env.OPENCODE_SESSION_ID = '';
process.env.PASEO_AGENT_ID = '';
// The index is disposable test discovery state; artifact seats and evidence are authoritative.
process.env.SQUARE_INDEX = path.join(state, 'index.ndjsonl');

process.on('exit', () => fs.rmSync(state, { recursive: true, force: true }));
