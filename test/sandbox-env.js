// Test processes must not inherit a live harness session or the real square
// registry: in-process library calls read the ambient environment, and a real
// PI_SESSION_ID would bind test participants to whichever session ran the suite.
// Loaded via `node --import`, so it runs in every test child process before the
// test file itself. Spawned CLI children override these variables via testEnv.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'square-test-env-'));

process.env.PI_SESSION_ID = '';
process.env.CLAUDE_CODE_SESSION_ID = '';
process.env.CLAUDE_CODE_CHILD_SESSION = '';
process.env.CODEX_THREAD_ID = '';
process.env.OPENCODE_SESSION_ID = '';
process.env.PASEO_AGENT_ID = '';
process.env.SQUARE_REGISTRY = path.join(state, 'sessions.ndjsonl');

process.on('exit', () => fs.rmSync(state, { recursive: true, force: true }));
