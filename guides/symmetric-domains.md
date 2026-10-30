# Two equal domains, using the public primitives

[`examples/symmetric-domains.mjs`](../examples/symmetric-domains.mjs) is a plain
ESM installed-package consumer. It imports only Node builtins and
`@astrosheep/square/attention`, `/receive`, and `/delivery`; it never constructs
`Square`. Two instances of the **same `Domain` implementation** independently
originate, receive, present and consume work. Neither is a master or a relay.

## Run from an installed package

In a consumer project with `@astrosheep/square` installed:

```sh
cp node_modules/@astrosheep/square/examples/symmetric-domains.mjs ./symmetric-domains.mjs
node ./symmetric-domains.mjs
```

The script prints a JSON summary. It also exports
`demonstrateSymmetricDomains()` for programmatic use. The repository's
`test/package-consumer.test.js` packs the package, copies the shipped example
into an isolated consumer, runs it there, and asserts the summary. It does not
substitute repository-relative imports, a second implementation, or path aliases.

## What the demonstration does

1. East originates a message for one local reader and two selected west readers.
   West independently originates a message for one local reader and two east
   readers. The static application directory supplies eligibility and destination
   routing; no primitive parses the recipient spelling.
2. Each origin commits its local item/audience before any link effect. East uses
   opaque random string keys; west uses decreasing negative numbers. Every
   destination assigns its own key. `data.origin` is just application data, not
   a global cursor, admission key or identity codec.
3. `resolveAudience` selects recipients; the application maps `{recipient, route}`
   once to receive's `{recipient, via}` addresses, preserving them locally and
   across the handoff. Application routing groups that result by destination.
   One `dispatchEffect` passes **one payload with both selected
   remote recipients**, not one payload per recipient. Its attempt series is
   bound to source item + destination + purpose in the source's private store.
4. East's link returns `accepted` after west admits. West's link deliberately
   returns `unknown` after east admits. Admission leaves both destination
   recipients pending. In both directions a second dispatch acquires no claim:
   the actual stored `accepted`/`unknown` attempt stops replay through
   `claimAttempt`, not a callback counter or link-level duplicate filter.
5. Each destination uses `preparePresentation` / `presentPrepared` to present the
   full payload to its first recipient. Settlement completes that recipient's
   presentation attempt and calls `recordConsumed` for the captured receipt in
   **one synchronous transaction**. The other recipient remains pending until
   separately consumed. Origin receipts are unchanged by destination consumption.
6. With the link disabled, both domains still admit and consume three local-only
   messages. Exact consumption of the middle item is repeatable; subsequent
   one-item pages find the older and newer receipt holes in local insertion order.
   No remote sink is invoked for this local work.

## Primitive responsibilities and caller obligations

| Primitive | Owns | Example caller supplies |
|---|---|---|
| `resolveAudience` | Deterministic attention selection | Eligible directory and explicit routing |
| `receive` | Item and address insertion | Local IDs, uniqueness, isolation and rollback |
| `consumeReceived` / `recordConsumed` | Selection/full receipts, first-write-wins coordinates | Ordered reads and recipient + local item receipt storage |
| `claimAttempt` / `settleAttempt` | Scoped attempt transitions, terminal uncertainty | One transaction-bound series, tokens, lease times and persistence |
| `dispatchEffect` | Claim/currentness/effect/timeout/settlement lifecycle | Bound port, link callback, pre-send policy and actual deadline enforcement |
| `preparePresentation` / `presentPrepared` | One-shot custody, sink outcome and settlement | Captured payload, receipt coordinates and atomic completion + receipts |

The memory adapter clones a draft and commits only when its synchronous callback
returns. A throw discards all changes, including an attempt completion if receipt
recording fails. It never holds a transaction across an `await`. Each effect claim
commits before external work; settlement opens a new transaction. Returned rows
are copied, and the two stores share no mutable state. A real application must
provide equivalent isolation, fencing, uniqueness and atomic rollback in its own
storage, plus durability if required. The primitives do not supply a database.

The link obeys `beforeSend()` and checks cancellation/deadline **after** awaiting
that gate, immediately before admission. A late policy answer is not permission
to send after timeout. Settlement does not re-check policy after a successful
sink: it records captured facts without erasing success or selecting new items.
Public effect reports distinguish callback observation from persistence results.

## Deliberately bounded claims

The adapter is nondurable illustrative memory, and the link is an in-process
function. `accepted` means destination admission only. Presentation success means
this example's callback captured the supplied full payload, **not** that a human
or model read it. Unknown suppresses automatic replay but does not reconcile it;
this example has no crash recovery, cross-domain transaction, exactly-once effect,
network protocol, federation, authentication or discovery implementation.

One handoff per destination is a boundary an application **could choose** for
billing. No charges, billing ledger or payment semantics are implemented here.
For the underlying contracts, see [attention](attention-primitive.md),
[receive](receive-primitive.md), and [delivery](delivery-primitives.md).
