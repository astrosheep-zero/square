import { execFileSync } from 'node:child_process';

import { waitForPaseoToolBoundary } from './paseo-timeline.js';

export interface PaseoAgent { id: string; name: string; status: string; cwd?: string; }

export function discoverPaseoAgents(timeoutMs = 5000): { agents: PaseoAgent[]; error?: string } {
  try {
    const raw = execFileSync(process.env.SQUARE_PASEO_BIN || 'paseo', ['ls', '--global', '--json'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as unknown;
    const agents = Array.isArray(parsed) ? parsed : (parsed as { agents?: unknown })?.agents;
    if (!Array.isArray(agents)) return { agents: [], error: 'Paseo returned malformed agent inventory.' };
    return {
      agents: agents.filter(
        (item): item is PaseoAgent =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as PaseoAgent).id === 'string' &&
          typeof (item as PaseoAgent).status === 'string'
      ),
    };
  } catch (error) {
    return { agents: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function waitForPaseoWakeBoundary(agent: Pick<PaseoAgent, 'id' | 'status'>, timeoutMs = 30_000): Promise<boolean> {
  if (agent.status === 'idle') return true;
  if (agent.status !== 'running') return false;
  return waitForPaseoToolBoundary(agent.id, { timeoutMs });
}
