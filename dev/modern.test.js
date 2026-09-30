import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { specTypeSchemas } from '@modelcontextprotocol/client';
const contract = JSON.parse(readFileSync(new URL('../test/tools-contract.json', import.meta.url), 'utf8'));
const serverFile = fileURLToPath(new URL('../server/index.js', import.meta.url));

const metadata = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'Claude Desktop replay', version: '1.0.0' }
};

async function exchange(requests) {
  const child = spawn(process.execPath, [serverFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => replies.push(JSON.parse(line)));
  const readerDone = new Promise(resolve => lines.once('close', resolve));
  try {
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Adapter exited ${code}`)));
    });
    await readerDone;
    return replies;
  } finally { lines.close(); child.kill(); }
}

test('Claude Desktop discover probe followed by modern tools/list validates against official SDK v2 schemas', async () => {
  const replies = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: metadata } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: metadata } }
  ]);
  assert.equal(replies.length, 2);
  for (const [index, schema] of ['DiscoverResult', 'ListToolsResult'].entries()) {
    const parsed = specTypeSchemas[schema]['~standard'].validate(replies[index].result);
    assert.deepEqual(parsed.issues, undefined);
  }
  assert.equal(replies[0].result.resultType, 'complete');
  assert.deepEqual(replies[0].result.supportedVersions, ['2026-07-28']);
  assert.equal(replies[1].result.resultType, 'complete');
  assert.equal(replies[1].result.ttlMs, 300000);
  assert.equal(replies[1].result.cacheScope, 'public');
  assert.equal(replies[1].result.nextCursor, undefined);
  assert.deepEqual(replies[1].result.tools, contract);
});

test('modern metadata and unsupported versions return specified protocol errors', async () => {
  const replies = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01', 'io.modelcontextprotocol/clientCapabilities': {} } } },
    { jsonrpc: '2.0', id: 5, method: 'initialize', params: { _meta: { ...metadata, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } },
    { jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: metadata, cursor: 'invalid' } },
    { jsonrpc: '2.0', id: 4, method: 'subscriptions/listen', params: { _meta: metadata, notifications: { toolsListChanged: true } } }
  ]);
  const byId = id => replies.find(reply => reply.id === id);
  const acknowledged = replies.find(reply => reply.method === 'notifications/subscriptions/acknowledged');
  assert.equal(byId(1).error.code, -32022);
  assert.equal(byId(1).error.data.requested, '1900-01-01');
  assert.deepEqual(byId(1).error.data.supported, ['2026-07-28']);
  assert.deepEqual(byId(5).error, { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '2025-11-25' } });
  assert.equal(byId(2).error.code, -32602);
  assert.equal(byId(3).error.code, -32602);
  assert.deepEqual(acknowledged.params.notifications, {});
  assert.equal(acknowledged.params._meta['io.modelcontextprotocol/subscriptionId'], 4);
  assert.equal(byId(4).result.resultType, 'complete');
  assert.equal(byId(4).result._meta['io.modelcontextprotocol/subscriptionId'], 4);
  assert.deepEqual(specTypeSchemas.SubscriptionsListenResult['~standard'].validate(byId(4).result).issues, undefined);
});
test('modern and legacy requests select handling per request', async () => {
  const initialize = { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
  const modern = id => ({ jsonrpc: '2.0', id, method: 'tools/list', params: { _meta: metadata } });
  const plain = id => ({ jsonrpc: '2.0', id, method: 'tools/list' });
  const replies = await exchange([plain(1), modern(2), initialize, modern(4), plain(5)]);
  const byId = id => replies.find(reply => reply.id === id);
  assert.equal(byId(1).error.code, -32602);
  assert.equal(byId(2).result.resultType, 'complete');
  assert.equal(byId(3).result.protocolVersion, '2025-11-25');
  assert.equal(byId(4).result.resultType, 'complete');
  assert.ok(byId(5).result.tools);
  const reverse = await exchange([initialize, modern(4)]);
  assert.equal(reverse.find(reply => reply.id === 4).result.resultType, 'complete');
});
