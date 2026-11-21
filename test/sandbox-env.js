// Test processes must not inherit a live harness session or a real Paseo
// daemon: library calls read the ambient environment. A real PI_SESSION_ID
// would bind participants to the session running the suite. Loaded via
// `node --import`, so it runs in every test child process before the test file
// itself. Spawned CLI children override these variables via testEnv.
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

delete process.env.SQUARE_OWNER;
delete process.env.SQUARE_KEIYAKU_SDK;
delete process.env.KEIYAKU_ACTOR_WORLD;
delete process.env.KEIYAKU_ACTOR_ID;
delete process.env.KEIYAKU_CLAUDE_ACTOR_SESSION;
process.env.PI_SESSION_ID = '';
process.env.CLAUDE_CODE_SESSION_ID = '';
process.env.CLAUDE_CODE_CHILD_SESSION = '';
process.env.CODEX_THREAD_ID = '';
process.env.OPENCODE_SESSION_ID = '';
process.env.PASEO_AGENT_ID = '';
// Every test process owns its disposable delivery ledger, never the live user's ledger.
process.env.SQUARE_DELIVERY = path.join(state, 'delivery.sqlite');
delete process.env.SQUARE_HOST_LEDGER_ROOT;

process.on('exit', () => fs.rmSync(state, { recursive: true, force: true }));
