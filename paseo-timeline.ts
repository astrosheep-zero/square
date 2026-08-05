import { setTimeout as sleep } from 'node:timers/promises';

export type PaseoToolStatus = 'running' | 'completed' | 'failed';
export interface PaseoToolCallSnapshot { callId: string; status: PaseoToolStatus; }
export interface PaseoTimelineSnapshot { agentStatus: string; toolCalls: PaseoToolCallSnapshot[]; }
export interface WaitForPaseoToolBoundaryOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  readSnapshot?: (agentId: string) => Promise<PaseoTimelineSnapshot>;
  delay?: (ms: number) => Promise<void>;
}

async function waitSnapshots(agentId: string, read: (id: string) => Promise<PaseoTimelineSnapshot>, opts: WaitForPaseoToolBoundaryOptions): Promise<boolean> {
  const initial = await read(agentId);
  if (initial.agentStatus === 'idle') return true;
  if (initial.agentStatus !== 'running') return false;
  const running = new Set(initial.toolCalls.filter((tool) => tool.status === 'running').map((tool) => tool.callId));
  if (running.size === 0) return true;
  const delay = opts.delay ?? ((ms: number) => sleep(ms));
  const interval = opts.pollIntervalMs ?? 100;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    await delay(interval);
    const current = await read(agentId);
    if (current.agentStatus === 'idle') return true;
    if (current.agentStatus !== 'running') return false;
    const states = new Map(current.toolCalls.map((tool) => [tool.callId, tool.status]));
    if ([...running].every((id) => states.get(id) === 'completed' || states.get(id) === 'failed')) return true;
  }
  return false;
}

function paseoUrl(): string {
  const value = process.env.SQUARE_PASEO_WS_URL?.trim() || process.env.PASEO_LISTEN?.trim();
  if (!value) return 'ws://127.0.0.1:6767/ws';
  if (/^wss?:\/\//i.test(value)) return value.replace(/\/$/, '') + (value.endsWith('/ws') ? '' : '/ws');
  if (/^\d+$/.test(value)) return `ws://127.0.0.1:${value}/ws`;
  return `ws://${value.replace(/\/$/, '')}/ws`;
}

async function remoteSnapshot(agentId: string): Promise<PaseoTimelineSnapshot> {
  const socket = new WebSocket(paseoUrl());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Paseo timeline connection timed out.')); }, 3000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Paseo timeline unavailable.')); }, { once: true });
  });
  return await new Promise<PaseoTimelineSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Paseo timeline request timed out.')); }, 3000);
    const requestId = `${process.pid}-${Date.now()}`;
    socket.addEventListener('message', (event) => {
      try {
        const outer = JSON.parse(String(event.data));
        const payload = outer?.message?.payload;
        if (outer?.message?.type !== 'fetch_agent_timeline_response' || payload?.requestId !== requestId) return;
        clearTimeout(timer); socket.close();
        const tools = new Map<string, PaseoToolStatus>();
        for (const entry of payload.entries ?? []) {
          const item = entry?.item;
          if (item?.type === 'tool_call' && typeof item.callId === 'string' && ['running', 'completed', 'failed'].includes(item.status)) tools.set(item.callId, item.status);
        }
        resolve({ agentStatus: typeof payload.agent?.status === 'string' ? payload.agent.status : 'unknown', toolCalls: [...tools].map(([callId, status]) => ({ callId, status })) });
      } catch { /* ignore unrelated frames */ }
    });
    socket.send(JSON.stringify({ type: 'hello', clientId: `square-${process.pid}`, clientType: 'cli', protocolVersion: 1 }));
    socket.send(JSON.stringify({ type: 'session', message: { type: 'fetch_agent_timeline_request', agentId, requestId, direction: 'tail', limit: 200, projection: 'projected' } }));
  });
}

export async function waitForPaseoToolBoundary(agentId: string, opts: WaitForPaseoToolBoundaryOptions = {}): Promise<boolean> {
  try { return await waitSnapshots(agentId, opts.readSnapshot ?? remoteSnapshot, opts); }
  catch { return false; }
}
