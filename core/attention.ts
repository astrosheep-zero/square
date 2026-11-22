export type DirectedAudienceRoute = 'mention' | 'reply' | 'attention';
export type AudienceRoute = DirectedAudienceRoute | 'bell';

export interface AudienceRecipient {
  readonly recipient: string;
  readonly route: DirectedAudienceRoute;
}

export interface AudienceInput {
  readonly actor: string;
  readonly recipients: readonly string[];
  readonly mentions?: readonly string[];
  readonly replyAuthor?: string;
  readonly incoming?: readonly { readonly listener: string; readonly kind: 'listen' | 'ignore' }[];
  readonly sameIdentity?: (a: string, b: string) => boolean;
}

/** Resolve attention against the caller's eligible recipient snapshot. */
export function resolveAudience(input: AudienceInput): readonly AudienceRecipient[] {
  const same = input.sameIdentity ?? ((a: string, b: string) => a === b);
  const incoming = input.incoming ?? [];
  const audience: AudienceRecipient[] = [];
  const add = (requested: string, route: DirectedAudienceRoute) => {
    const recipient = input.recipients.find((item) => same(item, requested));
    if (recipient === undefined || same(recipient, input.actor)
      || audience.some((item) => same(item.recipient, recipient))) return;
    if (incoming.some((item) => item.kind === 'ignore' && same(item.listener, recipient))) return;
    audience.push({ recipient, route });
  };
  for (const mention of input.mentions ?? []) add(mention, 'mention');
  if (input.replyAuthor !== undefined) add(input.replyAuthor, 'reply');
  for (const recipient of input.recipients) {
    if (incoming.some((item) => item.kind === 'listen' && same(item.listener, recipient))) add(recipient, 'attention');
  }
  return audience;
}
