import { createServer } from 'node:http';
import { readConfig } from '../server/core/config.js';
import { createContext } from '../server/core/registry.js';
export async function fixture(handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const call = { path: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const reply = await handler(call, res);
    if (!res.writableEnded && reply !== undefined) { res.statusCode = reply.status ?? 200; res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = readConfig({ PICO_BASE_URL: `http://127.0.0.1:${server.address().port}`, PICO_TIMEOUT_MS: '1000' });
  return { calls, config, ctx: createContext(config), close: () => new Promise(resolve => server.close(resolve)) };
}
