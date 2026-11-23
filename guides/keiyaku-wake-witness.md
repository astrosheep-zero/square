# Paired native Keiyaku wake witness

This is one acceptance run for a **pinned Square + Keiyaku pair**. It uses the real Pi SDK and
Square extension, and private OpenCode `serve` with its own dedicated stdio Square MCP child.
Run both lanes in one disposable World and square. A fixture may supply only model responses;
it must not replace Pi, OpenCode, the stdio client, actor identity, the Keiyaku SDK, or the Body.
A CLI join executed in place of a native tool call does not count.

## Before a run

- Record both clean candidate Git SHAs, the SHA-256 of each npm tarball, Node, Pi and OpenCode
  versions, and the exact run commands and fixture configuration. Use the two **candidate** npm
  tarballs, not published packages with the same manifest version. In each candidate checkout,
  build with its stock npm build and use `npm pack --pack-destination <absolute-dir>`.
- Create a fresh, canonical absolute scratch directory. In a clean shell (`env -i`, retain only
  an explicit executable `PATH` and the fixture variables), set `HOME`, `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `PI_CODING_AGENT_DIR`, `KEIYAKU_HOME` and
  `SQUARE_DELIVERY` to paths inside it. Do not forward existing `SQUARE_*`, `KEIYAKU_ACTOR_*`,
  `KEIYAKU_INITIATOR`, `KEIYAKU_EXTERNAL_CALLER`, native session variables or MCP configuration.
  Use no Paseo process, endpoint, provider or receiver plugin. Enable only the pinned Keiyaku
  Square observer in the witness World so the outcome path is present when checking for loops.
- In scratch only, stage the candidates together with npm. Verify the root paths from the
  installed packages, and that Square resolves Keiyaku to the staged candidate (or pin the absolute
  staged `@astrosheep/keiyaku` public entry as `SQUARE_KEIYAKU_SDK`). Confirm any transitive copy
  of Square is not the MCP or Pi tool binary under observation. Preserve the scratch lockfile.
  Set `SQ_TGZ`, `KEI_TGZ`, and `KEI_SQ_PLUGIN_TGZ` to absolute paths and `PI_VERSION=1.5.2`
  for this recipe:

  ```sh
  shasum -a 256 "$SQ_TGZ" "$KEI_TGZ" "$KEI_SQ_PLUGIN_TGZ"
  npm install --prefix "$scratch/pair" --ignore-scripts --prefer-offline --no-audit --no-fund --save-exact \
    "$SQ_TGZ" "$KEI_TGZ" "$KEI_SQ_PLUGIN_TGZ" "@earendil-works/pi-coding-agent@$PI_VERSION"
  npm ls --prefix "$scratch/pair" @astrosheep/square @astrosheep/keiyaku \
    @astrosheep/keiyaku-plugin-square @earendil-works/pi-coding-agent
  pair="$scratch/pair/node_modules/@astrosheep"
  sq="$pair/square/dist/square.js"
  kei="$pair/keiyaku/build/src/cli/index.js"
  export SQUARE_KEIYAKU_SDK="$pair/keiyaku/build/src/index.js"
  ```

- Set `world="$scratch/world"`; initialize a new Git repository and `world/.keiyaku` there.
  Use these test archetypes in `$KEIYAKU_HOME/akumas` (frontmatter and any short body):
  `witness-pi.md` uses `provider: pi` and `model: witness/witness-pi`;
  `witness-mcp.md` uses `provider: opencode-sdk` and `model: witness/witness-mcp`.
  For an additional unrelated owner, `witness-observer.md` uses `provider: pi` and
  `model: witness/witness-observer`.
  OpenCode must inherit the witness credential from the clean shell. Do not add
  `KEIYAKU_ACTOR_*` to OpenCode's MCP `environment`. Only the candidate's private launcher may
  supply them.
- Configure Pi before either Pi Body starts. The Pi CLI loads the shipped codemode extension;
  a Pi SDK session does not. `+codemode` only activates a tool that an extension registered.
  Load the pinned SDK's public factory as an ordinary Pi extension alongside the unchanged
  staged Square extension. The file imports from the same staged SDK as Keiyaku, not a global Pi:

  ```sh
  mkdir -p "$PI_CODING_AGENT_DIR"
  cat > "$scratch/pair/witness-codemode.mjs" <<'JS'
  import { createCodemodeExtension } from '@earendil-works/pi-coding-agent';
  export default createCodemodeExtension();
  JS
  node --input-type=module - "$scratch/pair/witness-codemode.mjs" \
    "$pair/square/plugins/pi/square-pi.js" <<'JS'
  import { writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({
    extensions: process.argv.slice(2),
    defaultTools: ['+codemode'],
  }, null, 2) + '\n');
  JS
  ```

  Retain the extension file and settings as evidence. The model fixture requires `codemode`
  in the Pi tool declarations and calls the real Square tools through it.
- Capture process start/exit evidence. The Keiyaku candidate's
  `tests/support/akuma-body-pid-receipt.mjs` may be used as a `NODE_OPTIONS=--import=<absolute-path>`
  observer with `KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT=$scratch/body-pids`. Pin its hash; do not enable
  any of its startup barriers. For OpenCode, use the native server PID and the stdio child's PID
  (a scratch-only wrapper can append `$$` and `$PPID` to a file, then `exec` the real Square command
  with unchanged env and stdio). Confirm exact PIDs have exited with `ps`, not just `wait` returning
  an answer. Do not keep a native receiver, Square watcher or a shared OpenCode server running.

## Run once

1. Set `file="$world/wake.square"` and `nonce=$(node -e 'process.stdout.write(crypto.randomUUID())')`.
   As the clean actorless external shell, build the square and join its sender:

   ```sh
   printf 'Paired native wake witness\n' | node "$sq" --location "$file" build
   node "$sq" --location "$file" --as witness-sender join
   ```

2. Start the loopback **model-only** fixture from the pinned Square checkout. It reads the advertised
   tool names, returns native tool requests, and logs the actual tool results sent back by the hosts:

   ```sh
   node "$squareCheckout/test/fixtures/keiyaku-witness-model.mjs" \
     "$scratch/model.url" "$scratch/model.ndjson" "$file" &
   model_pid=$!
   ```

   Wait for `model.url` before launching an Akuma. Stop this scratch process on exit; it is not a
   receiver and cannot dispatch Square cards. Run `export WITNESS_API_KEY=fixture` in the clean shell.
   Write the following isolated configuration (replace `<model-url>` with the complete URL from
   that file, including `/v1`).
   In `$PI_CODING_AGENT_DIR/models.json`:

   ```json
   {
     "providers": {
       "witness": {
         "baseUrl": "<model-url>", "api": "openai-completions", "apiKey": "fixture",
         "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
         "models": [{ "id": "witness-pi", "contextWindow": 32768, "maxTokens": 2048,
           "reasoning": false, "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }]
       }
     }
   }
   ```

   To include the unrelated owner, duplicate the Pi model entry with `id: witness-observer`.
   For OpenCode, pin the installed 2.0.20 executable. Its distribution bundles
   `@opencode/ai/providers/openai-compatible`; there is no separate provider install or cache
   prerequisite. The provider reads `settings.baseURL` and the configured `WITNESS_API_KEY` env
   entry; enable tool calls on `witness-mcp`. Use native `mcp.servers` nesting: the legacy flat MCP
   form does not preserve `codemode: false`, which the fixture needs for direct Square tools.
   In `$world/.keiyaku/settings.json` (`stdioObserver` implements the exec-only receiver PID
   observer above with the absolute Node/`sq` paths):

   ```json
   {
     "plugins": {
       "square": { "package": "@astrosheep/keiyaku-plugin-square", "enabled": true },
       "paseo": { "package": "@astrosheep/keiyaku-plugin-paseo", "enabled": false }
     },
     "providers": {
       "opencode-sdk": { "kind": "opencode-sdk", "executable": "<abs-opencode>", "config": {
         "providers": { "witness": { "package": "@opencode/ai/providers/openai-compatible",
           "env": ["WITNESS_API_KEY"], "settings": { "baseURL": "<model-url>" },
           "models": { "witness-mcp": { "capabilities": { "tools": true, "input": ["text"], "output": ["text"] } } } } },
         "mcp": { "servers": { "square": {
           "type": "local", "command": ["<abs-stdioObserver>"], "codemode": false
         } } }
       } }
     }
   }
   ```

3. Spawn the two Akumas sequentially with `node "$kei" -C "$world" spawn witness-pi --alias witness-pi
   'Square witness join pi-seat' --json` and `node "$kei" -C "$world" spawn witness-mcp --alias witness-mcp
   'Square witness join mcp-seat' --json`. The Pi fixture uses codemode with
   `text(await tools.square_join({location: file, as: "pi-seat"}))`. For OpenCode call the exposed
   join tool from the configured Square MCP server. No `bash`, user-supplied owner, manual `_meta`,
   or takeover. Retain spawn receipts (full AkuIds), tool calls/results and `node "$kei" -C "$world"
   history <full-AkuId> --json`. Allow both initial Bodies and the OpenCode serve/MCP processes to
   exit cleanly. Capture durable `asleep`, original Body sequence and physical PID exit for both.
   Use the read-only check below to capture original owner, seat generation and host route.

   With the unrelated owner enabled, also spawn `witness-observer` with prompt
   `'Square witness join observer-seat'`, retain the native join and prove its own initial Body has
   exited. Neither directed mention below includes this third owner.

4. Baseline all participating owners after their original Bodies have exited. Retain exact history
   (`--json`, no model-authored claims), process receipts and Square seat/ledger checks. There must
   be no pending mention for any of these seats and no outstanding manual Tell. Retain the baseline
   Keiyaku card keys and confirm the isolated Square observer is enabled and resolves to the pinned
   package, not a global installation.

5. For each lane in order, land one separate nonce-bearing CLI mention from the same actorless shell:

   ```sh
   node "$sq" --location "$file" --as witness-sender express --force --mention "$seat" \
     "directed-$seat-$nonce"
   ```

   Keep the exact `act/N` shown in the confirmation. Only that full AkuId gains exactly one new Tell for the coordinate,
   with no nonce body in the Tell itself. Check the focused transport test for the absence of a
   recipient initiator (native public history shows Tell text and delivery, not initiator). The
   successor turn has a different Body sequence and PID from the original. Neither a manual Tell
   nor any other prompt starts it.
   On the same provider, it uses the actual Square `perceive` tool with the exact `location`, `as`,
   and `id` from the Tell. Retain the native tool result showing that exact activity and matching
   directed nonce. Do not rejoin or take over. OpenCode must log a new stdio connection. After clean
   successor exit, compare all histories, ledger checks and process receipts with that lane's
   baseline. The other AkuId and any third owner gain no Tell, Body or pending entry for this
   activity. With the outcome observer enabled, the target gets no Keiyaku card back to itself,
   no second Tell and no third Body. Observe a bounded quiet window after each successor exits,
   without extra input or mutations, then repeat the read-only checks. Capture a new baseline
   for the second lane.

6. Compare owners and join generations before and after. History has one original join per
   seat and no intervening join/takeover/done. Ledger receipts do not claim the Tell was a
   presentation. Report the commands, artifacts and observations under one pair ID. A missing
   physical exit, rejected/unavailable tool, missing nonce, unexpected Tell/Body, or unavailable
   pinned partner artifact is a non-pass, not permission to substitute a mock or rerun the pair.

## Read-only Square seat / ledger check

Run from `$scratch/pair` with the witness environment and arguments `file world AkuId seat`;
repeat for every owner before and after each directed control. This selects public SDK facts
without reading the artifact directly or taking in activity.

```sh
(cd "$scratch/pair" && node --input-type=module - "$file" "$world" "$aku" "$seat" <<'JS'
import { akumaDeliveryOwner, DeliveryLedger, Square } from '@astrosheep/square';
const [path, world, akuId, name] = process.argv.slice(2);
const owner = akumaDeliveryOwner({ world, akuId });
const location = process.env.SQUARE_DELIVERY;
const square = await Square.at({ path, ledgerLocation: location });
const ledger = await DeliveryLedger.open({ location, readOnly: true });
try {
  const seat = await square.participant(name, { owner });
  const session = await ledger.session(owner);
  const pending = (await seat.pending()).activities.map(({ id }) => id);
  const cards = await ledger.cards({ owner, keyPrefix: ['square', square.location] });
  const outcomes = await ledger.cards({ owner, keyPrefix: ['keiyaku'] });
  const receipts = await ledger.receipts(owner);
  console.log(JSON.stringify({ name, owner, seatGeneration: seat.generation, session, pending, cards, outcomes, receipts }));
} finally { await square.close(); await ledger.close(); }
JS
)
```
