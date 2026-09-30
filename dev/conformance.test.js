import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { Client, specTypeSchemas } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { info } from '../server/core/server-info.js';
const contract = JSON.parse(readFileSync(new URL('../test/tools-contract.json', import.meta.url), 'utf8'));

const adapters = [
  ['shipped stdio', fileURLToPath(new URL('../server/index.js', import.meta.url))],
  ['SDK v2 stdio', fileURLToPath(new URL('./sdk-entry.js', import.meta.url))]
];
const modes = [
  ['legacy', 'legacy'],
  ['modern pinned', { pin: '2026-07-28' }],
  ['dual-era auto', 'auto']
];
const legacyVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

async function legacyExchange(version, baseUrl) {
  const child = spawn(process.execPath, [adapters[0][1]], { env: { ...process.env, PICO_BASE_URL: baseUrl }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => replies.push(JSON.parse(line)));
  const readerDone = new Promise(resolve => lines.once('close', resolve));
  try {
    for (const request of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'legacy-conformance', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pico_server_info', arguments: {} } },
      [{ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pico_server_info', arguments: {} } },
        { jsonrpc: '2.0', method: 'notifications/initialized' }]
    ]) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Adapter exited ${code}`)));
    });
    await readerDone;
    return replies;
  } finally { lines.close(); child.kill(); }
}

test('shipped stdio honors every advertised legacy protocol version', { timeout: 30000 }, async t => {
  const mock = await mockPico();
  try {
    for (const version of legacyVersions) await t.test(version, async () => {
      const replies = await legacyExchange(version, `http://127.0.0.1:${mock.address().port}`);
      const byId = id => replies.find(reply => reply.id === id);
      assert.equal(byId(1).result.protocolVersion, version);
      assert.deepEqual(byId(2).result.tools, contract);
      assert.equal(byId(3).result.structuredContent.version, '1.4.23');
      for (const [id, schema] of [[1, 'InitializeResult'], [2, 'ListToolsResult'], [3, 'CallToolResult']]) {
        assert.ok(specTypeSchemas[schema], `SDK schema ${schema} must exist`);
        assert.deepEqual(specTypeSchemas[schema]['~standard'].validate(byId(id).result).issues, undefined);
      }
      if (['2025-03-26', '2024-11-05'].includes(version)) {
        const batch = replies.find(Array.isArray);
        assert.equal(batch.length, 2);
        assert.deepEqual(batch.map(reply => reply.id).sort(), [4, 5]);
        for (const [id, schema] of [[4, 'ListToolsResult'], [5, 'CallToolResult']]) {
          assert.deepEqual(specTypeSchemas[schema]['~standard'].validate(batch.find(reply => reply.id === id).result).issues, undefined);
        }
      } else {
        const rejected = replies.find(reply => reply.id === null);
        assert.equal(rejected.error.code, -32600);
      }
    });
  } finally { await new Promise(resolve => mock.close(resolve)); }
});

async function mockPico() {
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Drain the request body. */ }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/version'
      ? { bundle_identifier: 'com.example.PicoMock', version: '1.4.23', build: '147', name: 'Pico Mock' } : {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('official SDK v2 clients exercise both adapters in every supported era mode', { timeout: 60000 }, async t => {
  const mock = await mockPico();
  try {
    for (const [adapter, file] of adapters) {
      for (const [label, mode] of modes) {
        await t.test(`${adapter}: ${label}`, { timeout: 10000 }, async () => {
          const transport = new StdioClientTransport({
            command: process.execPath, args: [file],
            env: { ...process.env, PICO_BASE_URL: `http://127.0.0.1:${mock.address().port}` }, stderr: 'pipe'
          });
          const client = new Client({ name: 'conformance-test', version: '1.0.0' }, {
            versionNegotiation: { mode }
          });
          try {
            await client.connect(transport);
            assert.equal(client.getProtocolEra(), label === 'legacy' ? 'legacy' : 'modern');
            assert.equal(client.getServerCapabilities().tools.listChanged, false);
            if (label === 'legacy') {
              assert.equal(client.getServerVersion().version, info.version);
              assert.equal(client.getDiscoverResult(), undefined);
            } else {
              assert.deepEqual(client.getDiscoverResult().supportedVersions, ['2026-07-28']);
            }
            assert.equal(client.getInstructions(), info.instructions);
            const listed = await client.listTools();
            assert.deepEqual(listed.tools, contract);
            assert.equal(listed.nextCursor, undefined);

            const success = await client.callTool({ name: 'pico_server_info', arguments: {} });
            assert.equal(success.isError, undefined);
            assert.equal(success.structuredContent.version, '1.4.23');
            assert.deepEqual(success.structuredContent, { reachable: true, base_url: `http://127.0.0.1:${mock.address().port}`, version: '1.4.23', name: 'Pico Mock', build: '147', bundle_identifier: 'com.example.PicoMock' });

            const invalid = await client.callTool({ name: 'pico_responses', arguments: { input: 42 } });
            assert.equal(invalid.isError, true);
            for (const [args, message] of [
              [{ json_schema: { type: 'object' } }, 'json_schema_name is required with json_schema.'],
              [{ json_schema_name: 'answer' }, 'json_schema is required with json_schema_name.']
            ]) {
              const result = await client.callTool({ name: 'pico_responses', arguments: { input: 'hi', ...args } });
              assert.equal(result.isError, true);
              assert.deepEqual(result.structuredContent, { source: 'bridge', kind: 'invalid_arguments', message });
            }

            await assert.rejects(client.callTool({ name: 'unknown', arguments: {} }), error => {
              assert.equal(error.code, -32602);
              return true;
            });

            const raw = await client.callTool({ name: 'pico_server_info', arguments: { raw: true } });
            assert.deepEqual(raw.structuredContent, { status: 200, body: { bundle_identifier: 'com.example.PicoMock', version: '1.4.23', build: '147', name: 'Pico Mock' } });
            if (label === 'legacy') await client.ping();
            else await assert.rejects(client.ping(), error => {
              assert.equal(error.code, 'METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION');
              return true;
            });
            if (label !== 'legacy') {
              const subscription = await client.listen({ toolsListChanged: true });
              await subscription.close();
              assert.equal(await subscription.closed, 'local');
            }
          } finally { await client.close(); }
        });
      }
    }
  } finally { await new Promise(resolve => mock.close(resolve)); }
});
