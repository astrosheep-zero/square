/** Producer-neutral display facts; independent of model-facing delivery text. */
export type CardPresentation = {
  readonly kind: 'presentation';
  readonly origin: string;
  readonly author?: string;
  /** Optional short text beside the signature, supplied by the producer. */
  readonly label?: string;
  readonly ref?: string;
  /** Absent on cards produced before landing time and reach were recorded. */
  readonly at?: number;
  readonly reach?: 'mention' | 'reply' | 'attention' | 'bell';
  /** The participant this card reached; names a mention. Absent on older cards. */
  readonly recipient?: string;
  /** Author of the activity being answered, captured from producer facts. Absent on older cards. */
  readonly replyTo?: string;
  readonly body: string;
};

export function isCardPresentation(value: unknown): value is CardPresentation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.kind === 'presentation' && typeof item.origin === 'string' && typeof item.body === 'string'
    && (item.at === undefined || (typeof item.at === 'number' && Number.isFinite(item.at)))
    && (item.reach === undefined || ['mention', 'reply', 'attention', 'bell'].includes(item.reach as string))
    && ['author', 'label', 'ref', 'recipient', 'replyTo'].every(key => item[key] === undefined || typeof item[key] === 'string');
}
