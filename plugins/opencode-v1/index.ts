interface LegacyContext {
  readonly serverUrl: string | URL;
  readonly directory: string;
  readonly project: { readonly id: string };
  readonly client: { readonly session: {
    get(input: unknown): Promise<{ data?: unknown; error?: unknown }>;
    promptAsync(input: unknown): Promise<{ error?: unknown; response?: Response }>;
  } };
}

/** Legacy loader: no storage imports until the actual host and runtime qualify. */
export default async function squareOpenCodeV1(ctx: LegacyContext) {
  const shell = async (input: { sessionID?: string }, output: { env: Record<string, string> }) => {
    if (typeof input.sessionID === 'string' && input.sessionID) output.env.OPENCODE_SESSION_ID = input.sessionID;
  };
  const reduced = { 'shell.env': shell };
  try {
    let response: Response;
    try { response = await fetch(new URL('/global/health', ctx.serverUrl), { signal: AbortSignal.timeout(1500) }); }
    catch { throw new Error('health endpoint unreachable (embedded TUI may not expose it)'); }
    if (!response.ok) throw new Error(`health endpoint returned HTTP ${response.status} (embedded TUI may not expose it)`);
    const health = await response.json() as { version?: unknown };
    const match = typeof health.version === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(health.version);
    if (!match || Number(match[1]) !== 1 || Number(match[2]) < 15 || (Number(match[2]) === 15 && Number(match[3]) < 11)) throw new Error('native version below resident floor or unknown');
    if (typeof ctx.client?.session?.get !== 'function' || typeof ctx.client.session.promptAsync !== 'function') throw new Error('native session API unavailable');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try { db.exec('CREATE TABLE capability (value TEXT)'); db.prepare('INSERT INTO capability VALUES (?)').run('ok'); db.prepare('SELECT value FROM capability').get(); }
    finally { db.close(); }
    const { startReceiver } = await import('./runtime.js');
    return { ...reduced, ...await startReceiver(ctx) };
  } catch (error) {
    console.warn(`[square] OpenCode 1.x reduced mode (no proactive delivery): ${error instanceof Error ? error.message : String(error)}`);
    return reduced;
  }
}
