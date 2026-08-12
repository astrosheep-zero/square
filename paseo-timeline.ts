import { setTimeout as sleep } from 'node:timers/promises';

import { connectPaseoDaemon } from './paseo-connection.js';

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

function snapshotFromPayload(payload: Awaited<ReturnType<Awaited<ReturnType<typeof connectPaseoDaemon>>['fetchAgentTimeline']>>): PaseoTimelineSnapshot {
  const tools = new Map<string, PaseoToolStatus>();
  for (const entry of payload.entries ?? []) {
    const item = entry.item;
    if (item.type === 'tool_call' && ['running', 'completed', 'failed'].includes(item.status)) {
      tools.set(item.callId, item.status as PaseoToolStatus);
    }
  }
  return {
    agentStatus: payload.agent?.status ?? 'unknown',
    toolCalls: [...tools].map(([callId, status]) => ({ callId, status })),
  };
}

export async function waitForPaseoToolBoundary(agentId: string, opts: WaitForPaseoToolBoundaryOptions = {}): Promise<boolean> {
  if (opts.readSnapshot !== undefined) {
    try { return await waitSnapshots(agentId, opts.readSnapshot, opts); }
    catch { return false; }
  }

  let client: Awaited<ReturnType<typeof connectPaseoDaemon>> | undefined;
  try {
    client = await connectPaseoDaemon();
    return await waitSnapshots(
      agentId,
      async (id) => snapshotFromPayload(await client!.fetchAgentTimeline(id, {
        direction: 'tail',
        limit: 200,
        projection: 'projected',
        timeout: 3_000,
      })),
      opts
    );
  } catch {
    return false;
  } finally {
    await client?.close().catch(() => {});
  }
}
