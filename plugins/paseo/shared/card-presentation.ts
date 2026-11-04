/** Producer-neutral display facts; independent of model-facing delivery text. */
export type CardPresentation = {
  readonly kind: 'presentation';
  readonly origin: string;
  readonly author?: string;
  readonly ref?: string;
  readonly badge?: string;
  readonly body: string;
};

export function isCardPresentation(value: unknown): value is CardPresentation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.kind === 'presentation' && typeof item.origin === 'string' && typeof item.body === 'string'
    && ['author', 'ref', 'badge'].every(key => item[key] === undefined || typeof item[key] === 'string');
}
