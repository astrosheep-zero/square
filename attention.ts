export type AudienceRoute = 'mention' | 'reply' | 'attention' | 'bell';

export interface AudienceRecipient {
  readonly recipient: string;
  readonly route: AudienceRoute;
}

export interface AudienceInput {
  readonly actor: string;
  readonly recipients: readonly string[];
  readonly mentions?: readonly string[];
  readonly replyAuthor?: string;
  readonly reach?: 'bell';
  readonly incoming?: readonly { readonly listener: string; readonly kind: 'listen' | 'ignore' }[];
  readonly sameIdentity?: (a: string, b: string) => boolean;
}

/** Resolve attention against the caller's eligible recipient snapshot. */
export function resolveAudience(input: AudienceInput): readonly AudienceRecipient[] {
  const same = input.sameIdentity ?? ((a: string, b: string) => a === b);
  const incoming = input.incoming ?? [];
  const audience: AudienceRecipient[] = [];
  const add = (requested: string, route: AudienceRoute) => {
    const recipient = input.recipients.find((item) => same(item, requested));
    if (recipient === undefined || same(recipient, input.actor)
      || audience.some((item) => same(item.recipient, recipient))) return;
    if (input.reach !== 'bell' && incoming.some((item) => item.kind === 'ignore' && same(item.listener, recipient))) return;
    audience.push({ recipient, route });
  };
  if (input.reach === 'bell') {
    for (const recipient of input.recipients) add(recipient, 'bell');
  } else {
    for (const mention of input.mentions ?? []) add(mention, 'mention');
    if (input.replyAuthor !== undefined) add(input.replyAuthor, 'reply');
    for (const recipient of input.recipients) {
      if (incoming.some((item) => item.kind === 'listen' && same(item.listener, recipient))) add(recipient, 'attention');
    }
  }
  return audience;
}
