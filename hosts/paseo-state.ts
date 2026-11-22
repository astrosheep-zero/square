import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { waitForPaseoToolBoundary } from './paseo-timeline.js';

const execFileAsync = promisify(execFile);

export interface PaseoAgent { id: string; name: string; status: string; cwd?: string; }

export async function discoverPaseoAgents(
  timeoutMs = 5000,
  opts: { args?: string[]; bin?: string } = {},
): Promise<{ agents: PaseoAgent[]; error?: string }> {
  try {
    const { stdout: raw } = await execFileAsync(opts.bin ?? process.env.SQUARE_PASEO_BIN ?? 'paseo', [...(opts.args ?? []), 'ls', '--global', '--json'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
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
