# Attention audience resolution

The standalone `@astrosheep/square/attention` subpath computes an audience from
caller data. It does not open a square, send or consume anything, or grant permission.

```ts
import { resolveAudience } from '@astrosheep/square/attention';

const audience = resolveAudience({
  actor: 'east:alice',
  recipients: ['east:bob', 'west:carol'],
  mentions: ['west:carol'],
  incoming: [{ listener: 'east:bob', kind: 'listen' }],
});
// [{ recipient: 'west:carol', route: 'mention' },
//  { recipient: 'east:bob', route: 'attention' }]
```

The caller supplies eligible recipients in canonical spelling and order, and owns
their validation and persistence. Identity is exact by default; `sameIdentity` may
provide a deterministic equivalence relation. The first equivalent recipient gives
the output spelling. Mentions precede the reply author, followed by listeners in
recipient order; ignores exclude all three. A `reach: 'bell'` reaches all eligible
recipients except the actor, bypassing ignores. Equivalent recipients appear once.

The caller decides whether a bell's recipient snapshot is local or global, and when
that snapshot is authoritative. Square supplies its standing participants and
incoming relationships at landing, inside its persistence transaction. The result
is computed attention, separate from delivery and consumption.
