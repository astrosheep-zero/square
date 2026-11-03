import type { DeliveryCard, DeliveryTransport, DeliveryTransportContext, TransportOutcome } from './delivery-ledger.js';
export interface HttpWakeTransportOptions { fetch?: typeof fetch; env?: NodeJS.ProcessEnv }

function configuration(address: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv): { url: string; headers: Headers } | undefined {
  try {
    const url = new URL(address.url!);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || address.url!.includes('#')) return undefined;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (address.tokenEnv !== undefined) {
      const token = address.tokenEnv.trim() ? env[address.tokenEnv] : undefined;
      if (!token || token !== token.trim() || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) return undefined;
      headers.set('Authorization', `Bearer ${token}`);
    }
    return { url: address.url!, headers };
  } catch { return undefined; }
}

/** A successful HTTP response acknowledges custody, not presentation. */
export class HttpWakeTransport implements DeliveryTransport {
  readonly kind = 'http';
  constructor(private readonly opts: HttpWakeTransportOptions = {}) {}
  async send(card: DeliveryCard, address: Readonly<Record<string, string>>, context: DeliveryTransportContext): Promise<TransportOutcome> {
    const config = configuration(address, this.opts.env ?? process.env);
    if (!config) return 'not-capable';
    if (!await context.beforeSend() || context.signal.aborted || Date.now() >= context.deadline) return 'not-capable';
    try {
      const response = await (this.opts.fetch ?? fetch)(config.url, { method: 'POST', headers: config.headers,
        body: JSON.stringify({ owner: card.owner, key: card.key, text: card.text }), redirect: 'manual', signal: context.signal });
      void response.body?.cancel().catch(() => undefined);
      return response.status >= 200 && response.status < 300 ? 'accepted' : 'failed';
    } catch { return 'unknown'; }
  }
}
