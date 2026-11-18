// Model upstream only. The host selects its real tool from the advertised declarations;
// this fixture has no Square/Keiyaku imports or native runtime access.
import { createServer } from 'node:http';
import { appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const [ready, log, square] = process.argv.slice(2);
if (!ready || !log || !square || realpathSync(square) !== square) throw new Error('Expected ready path, log path, and canonical witness square');

const text = message => typeof message.content === 'string' ? message.content :
  message.content?.map(block => block.text ?? '').join('') ?? '';
const models = { 'witness-pi': 'pi-seat', 'witness-mcp': 'mcp-seat', 'witness-observer': 'observer-seat' };
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return res.writeHead(404).end();
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { model, messages, tools } = JSON.parse(body);
    const seat = Object.hasOwn(models, model) ? models[model] : undefined;
    if (!seat) throw new Error('Unexpected fixture model');
    const start = messages.findLastIndex(message => message.role === 'user');
    const input = start === -1 ? '' : text(messages[start]);
    const isJoin = input.includes(`Square witness join ${seat}`);
    let id;
    if (!isJoin) {
      const awareness = input.match(/A Square mention reached you\. Use Square perceive with (\{[^\n]*\})\./u);
      const coords = awareness && JSON.parse(awareness[1]);
      if (!coords || coords.location !== square || coords.as !== seat || typeof coords.id !== 'string' || !/^act\/(0|[1-9]\d*)$/u.test(coords.id))
        throw new Error('Unexpected fixture input or mention coordinates');
      id = coords.id;
    }
    const operation = isJoin ? 'join' : 'perceive';
    const result = messages.slice(start + 1).findLast(message => message.role === 'tool');
    let delta, finish;
    if (result) {
      appendFileSync(log, JSON.stringify({ model, operation, result: text(result) }) + '\n');
      delta = { content: text(result) };
      finish = 'stop';
    } else {
      const names = tools.flatMap(tool => tool.function?.name ?? tool.custom?.name ?? []);
      const args = { location: square, as: seat, ...(id === undefined ? {} : { id }) };
      const pi = model !== 'witness-mcp';
      const name = pi ? 'codemode' : names.find(candidate => candidate === `square_${operation}`);
      if (!names.includes(name)) throw new Error(`Missing fixture tool ${name ?? operation}; available: ${names.join(', ')}`);
      const code = `text(await tools.square_${operation}(${JSON.stringify(args)}));`;
      appendFileSync(log, JSON.stringify({ model, operation, tool: name, args }) + '\n');
      delta = { tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: 'function',
        function: { name, arguments: JSON.stringify(pi ? { code } : args) } }] };
      finish = 'tool_calls';
    }
    const stub = { id: `cmpl_${randomUUID()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
    const send = choices => res.write(`data: ${JSON.stringify({ ...stub, choices })}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    send([{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }]);
    send([{ index: 0, delta: {}, finish_reason: finish }]);
    res.end('data: [DONE]\n\n');
  } catch (error) {
    appendFileSync(log, JSON.stringify({ error: String(error) }) + '\n');
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(error) } }));
  }
});
server.listen(0, '127.0.0.1', () => writeFileSync(ready, `http://127.0.0.1:${server.address().port}/v1\n`, { flag: 'wx' }));
