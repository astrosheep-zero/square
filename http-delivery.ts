import type { WakeRoute } from './model.js';
import type { WakeOutcome, WakeRequest, WakeTransportPort } from './ports.js';
import { wakePreview } from './delivery.js';

export interface HttpWakeTransportOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Configuration only: probing never contacts the receiver. */
function configuration(route: WakeRoute, env: NodeJS.ProcessEnv): { url: string; headers: Headers } | undefined {
  if (route.kind !== 'http') return undefined;
  try {
    const url = new URL(route.address.url!);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || route.address.url!.includes('#')) return undefined;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const tokenEnv = route.address.tokenEnv;
    if (tokenEnv !== undefined) {
      const token = tokenEnv.trim() ? env[tokenEnv] : undefined;
      // RFC 6750 bearer credentials; whitespace/control characters cannot become headers.
      if (!token || token !== token.trim() || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) return undefined;
      headers.set('Authorization', `Bearer ${token}`);
    }
    return { url: route.address.url!, headers };
  } catch { return undefined; }
}

/** HTTP accepts wake custody only; it never consumes or presents Square activity. */
export class HttpWakeTransport implements WakeTransportPort {
  constructor(private readonly opts: HttpWakeTransportOptions = {}) {}

  async probe(route: WakeRoute): Promise<boolean | { outcome: 'not-capable'; diagnostic: string }> {
    return configuration(route, this.opts.env ?? process.env) !== undefined
      ? true : { outcome: 'not-capable', diagnostic: 'HTTP wake configuration unavailable.' };
  }

  async attempt(request: WakeRequest, timeoutMs: number, beforeSend: () => Promise<boolean>): Promise<WakeOutcome> {
    const deadline = Date.now() + timeoutMs;
    if (request.route.kind !== 'http') return { outcome: 'not-capable' };
    const config = configuration(request.route, this.opts.env ?? process.env);
    if (config === undefined) return { outcome: 'failed', signature: 'http_config_rejected', message: 'Invalid HTTP wake configuration.' };
    const controller = new AbortController();
    let sent = false;
    const budgetUnavailable = (): WakeOutcome => sent
      ? { outcome: 'unknown', signature: 'http_send_timeout', message: 'HTTP wake acceptance is unknown after timeout.' }
      : { outcome: 'failed', signature: 'http_pre_send_timeout', message: 'HTTP wake budget elapsed before sending.' };
    if (!Number.isFinite(timeoutMs) || Date.now() >= deadline) return budgetUnavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<WakeOutcome>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(budgetUnavailable()); }, Math.max(0, deadline - Date.now()));
    });
    const send = async (): Promise<WakeOutcome> => {
      try {
        const preview = request.artifact === undefined ? undefined
          : (await request.artifact.read(facts => wakePreview(facts, request), controller.signal)).value;
        if (preview === undefined) return { outcome: 'not-capable', diagnostic: 'No pending Square activity to preview.' };
        const body = JSON.stringify({
          location: request.location, participant: request.participant, activity: request.activity, actor: request.actor,
          ...(request.attemptN === undefined ? {} : { attemptN: request.attemptN }), preview,
        });
        if (controller.signal.aborted || Date.now() >= deadline) return budgetUnavailable();
        if (!(await beforeSend())) return { outcome: 'not-capable' };
        // Preview and the final gate spend the same absolute budget as the request.
        if (controller.signal.aborted || Date.now() >= deadline) return budgetUnavailable();
        sent = true;
        const response = await (this.opts.fetch ?? fetch)(config.url, {
          method: 'POST', headers: config.headers, body, redirect: 'manual', signal: controller.signal,
        });
        // Status is the whole acknowledgement; never wait for or buffer a receiver body.
        void response.body?.cancel().catch(() => undefined);
        if (response.status >= 200 && response.status < 300) return { outcome: 'accepted', signature: 'http_accepted' };
        return {
          outcome: 'failed', signature: response.status >= 500 && response.status < 600 ? 'http_status_transient' : 'http_status_rejected',
          message: `HTTP wake returned status ${response.status}.`,
        };
      } catch {
        // URLs, query credentials and raw fetch exceptions must never reach evidence.
        if (controller.signal.aborted) return budgetUnavailable();
        return sent
          ? { outcome: 'unknown', signature: 'http_send_unknown', message: 'HTTP wake acceptance is unknown after a network error.' }
          : { outcome: 'failed', signature: 'http_pre_send_failed', message: 'HTTP wake could not be prepared.' };
      }
    };
    try { return await Promise.race([send(), timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
