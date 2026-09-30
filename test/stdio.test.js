import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStdioJsonRpc } from '../server/adapters/stdio-jsonrpc.js';
import { info } from '../server/core/server-info.js';
import { PassThrough } from 'node:stream';
import { fixture } from './fixtures.js';
test('raw JSON tool arguments reject unsafe integers and nonfinite numbers before Pico', async () => {
  const f = await fixture(() => ({ body: {} }));
  const input = new PassThrough(), output = new PassThrough();
  let written = '';
  output.on('data', chunk => { written += chunk; });
  const adapter = startStdioJsonRpc({ info, stdin: input, stdout: output, stderr: new PassThrough(), config: f.config });
  try {
    await adapter.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' }
    } }));
    for (const [field, value, message] of [
      ['max_tokens', '9007199254740993', 'arguments.max_tokens must be a safe integer'],
      ['temperature', '1e309', 'arguments.temperature must be a finite number']
    ]) {
      const line = `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pico_chat_completions","arguments":{"prompt":"hi","${field}":${value}}}}`;
      await adapter.handleLine(line);
      const result = JSON.parse(written.trim().split('\n').at(-1)).result;
      assert.equal(result.structuredContent.kind, 'invalid_arguments');
      assert.match(result.structuredContent.message, new RegExp(message));
    }
    assert.equal(f.calls.length, 0);
  } finally { adapter.close(); input.end(); output.end(); await f.close(); }
});
test('non-object requests and notifications', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const adapter = startStdioJsonRpc({ info, stdin: input, stdout: output, stderr: new PassThrough() });
  try {
    for (const value of [null, 2, 'x', []]) assert.equal((await adapter.dispatch(value)).error.code, -32600);
    assert.equal(await adapter.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  } finally { adapter.close(); input.end(); output.end(); }
});
test('legacy ping before initialize returns an empty result', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const adapter = startStdioJsonRpc({ info, stdin: input, stdout: output, stderr: new PassThrough() });
  try {
    assert.deepEqual(await adapter.dispatch({ jsonrpc: '2.0', id: 1, method: 'ping' }), { jsonrpc: '2.0', id: 1, result: {} });
    assert.deepEqual(await adapter.dispatch({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' }), { jsonrpc: '2.0', id: 'ping-1', result: {} });
    for (const id of [1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) assert.deepEqual(await adapter.dispatch({ jsonrpc: '2.0', id, method: 'ping' }), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    assert.deepEqual(await adapter.dispatch({ jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER, method: 'ping' }), { jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER, result: {} });
    assert.ok((await adapter.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).error);
  } finally { adapter.close(); input.end(); output.end(); }
});
test('spawned stdio emits only valid JSON-RPC lines', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const readerDone = new Promise(resolve => child.stdout.once('end', resolve));
    child.stdin.write('not json\n');
    child.stdin.write('2\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    child.stdin.end();
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`Adapter exited ${code}`)));
    });
    await readerDone;
    const lines = stdout.trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.equal(line.jsonrpc, '2.0');
    assert.equal(lines[0].error.code, -32700); assert.equal(lines[0].id, null);
    assert.equal(lines[1].error.code, -32600);
  } finally { child.stdin.destroy(); child.kill(); }
});
test('request params array returns Invalid params', async () => {
  const adapter = startStdioJsonRpc({ info, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    const response = await adapter.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: [] });
    assert.equal(response.error.code, -32602);
    assert.equal(response.error.message, 'Invalid params');
  } finally { adapter.close(); }
});
const modernMeta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const legacyInitialize = (id, version = '2025-11-25') => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
test('older legacy revisions receive JSON-RPC batches', async () => {
  for (const version of ['2025-03-26', '2024-11-05']) {
    const input = new PassThrough(), output = new PassThrough();
    let written = '';
    output.on('data', chunk => { written += chunk; });
    const adapter = startStdioJsonRpc({ info, stdin: input, stdout: output, stderr: new PassThrough() });
    const send = request => adapter.handleLine(JSON.stringify(request));
    try {
      await send(legacyInitialize(0, version));
      written = '';
      await send([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', method: 'notifications/initialized' }]);
      let replies = written.trim().split('\n').map(JSON.parse);
      assert.equal(replies.length, 1);
      assert.ok(Array.isArray(replies[0]));
      assert.deepEqual(replies[0].map(reply => reply.id), [1, 2]);
      assert.deepEqual(replies[0][0].result, {});
      assert.ok(replies[0][1].result.tools.length);
      written = '';
      await send([]);
      assert.deepEqual(JSON.parse(written.trim()), { jsonrpc: '2.0', id: null,
        error: { code: -32600, message: 'Invalid Request' } });
      written = '';
      await send([legacyInitialize(3, version), { jsonrpc: '2.0', id: 4, method: 'ping' }, 7]);
      replies = written.trim().split('\n').map(JSON.parse);
      assert.equal(replies.length, 1);
      assert.deepEqual(replies[0].map(reply => reply.id), [3, 4, null]);
      assert.equal(replies[0][0].error.code, -32600);
      assert.deepEqual(replies[0][1].result, {});
      assert.equal(replies[0][2].error.code, -32600);
      written = '';
      await send([{ jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } },
        { jsonrpc: '2.0', method: 'initialize' }]);
      assert.equal(written, '');
      await send(legacyInitialize(5, '2025-11-25'));
      written = '';
      await send([{ jsonrpc: '2.0', id: 6, method: 'ping' }]);
      assert.deepEqual(JSON.parse(written.trim()), { jsonrpc: '2.0', id: null,
        error: { code: -32600, message: 'Invalid Request' } });
    } finally { adapter.close(); input.end(); output.end(); }
  }
});
test('newer legacy and modern handling reject array lines', async () => {
  for (const version of [null, '2025-06-18', '2025-11-25']) {
    const input = new PassThrough(), output = new PassThrough();
    let written = '';
    output.on('data', chunk => { written += chunk; });
    const adapter = startStdioJsonRpc({ info, stdin: input, stdout: output, stderr: new PassThrough() });
    try {
      if (version) { await adapter.handleLine(JSON.stringify(legacyInitialize(0, version))); written = ''; }
      await adapter.handleLine(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
      assert.deepEqual(JSON.parse(written.trim()), { jsonrpc: '2.0', id: null,
        error: { code: -32600, message: 'Invalid Request' } });
    } finally { adapter.close(); input.end(); output.end(); }
  }
});
test('older legacy batch rejects modern elements individually', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let written = '';
  output.on('data', chunk => { written += chunk; });
  const adapter = startStdioJsonRpc({ info, stdin: input, stdout: output, stderr: new PassThrough() });
  try {
    await adapter.handleLine(JSON.stringify(legacyInitialize(0, '2025-03-26')));
    written = '';
    await adapter.handleLine(JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta } },
      { jsonrpc: '2.0', id: 2, method: 'server/discover', params: { _meta: modernMeta } },
      { jsonrpc: '2.0', id: 3, method: 'ping' }
    ]));
    assert.deepEqual(JSON.parse(written.trim()), [
      { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' } },
      { jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'Invalid Request' } },
      { jsonrpc: '2.0', id: 3, result: {} }
    ]);
    written = '';
    await adapter.handleLine(JSON.stringify([
      { jsonrpc: '2.0', id: null, method: 'server/discover' },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: modernMeta } }
    ]));
    assert.deepEqual(JSON.parse(written.trim()), [
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }
    ]);
    written = '';
    await adapter.handleLine(JSON.stringify([{ jsonrpc: '2.0', method: 'server/discover' }]));
    assert.equal(written, '');
  } finally { adapter.close(); input.end(); output.end(); }
});
test('modern subscription acknowledges and completes when stdin closes', { timeout: 10000 }, async () => {
  const input = new PassThrough(), output = new PassThrough();
  const adapter = startStdioJsonRpc({ info, stdin: input, stdout: output, stderr: new PassThrough() });
  const next = () => new Promise(resolve => output.once('data', chunk => resolve(JSON.parse(String(chunk).trim()))));
  try {
    const acknowledged = next();
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'subscriptions/listen',
      params: { notifications: { toolsListChanged: true }, _meta: modernMeta } }) + '\n');
    assert.deepEqual(await acknowledged, { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
      params: { _meta: { 'io.modelcontextprotocol/subscriptionId': 7 }, notifications: {} } });
    const completed = next();
    input.end();
    const response = await completed;
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 7);
    assert.equal(response.result?.resultType, 'complete');
    assert.deepEqual(response.result._meta, { 'io.modelcontextprotocol/serverInfo': { name: info.name, version: info.version },
      'io.modelcontextprotocol/subscriptionId': 7 });
  } finally { adapter.close(); input.end(); output.end(); }
});
test('requests reject present non-object metadata in both eras', async () => {
  const adapter = startStdioJsonRpc({ info, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    for (const value of [42, []]) {
      assert.equal((await adapter.dispatch({ ...legacyInitialize(1), params: { ...legacyInitialize(1).params, _meta: value } })).error.code, -32602);
    }
    assert.equal((await adapter.dispatch(legacyInitialize(2))).result.protocolVersion, '2025-11-25');
    for (const value of [42, []]) for (const [method, params] of [
      ['tools/list', {}], ['tools/call', { name: 'pico_server_info', arguments: {} }], ['ping', {}], ['server/discover', {}]
    ]) {
      const response = await adapter.dispatch({ jsonrpc: '2.0', id: 3, method, params: { ...params, _meta: value } });
      assert.deepEqual(response.error, { code: -32602, message: 'Invalid params' });
    }
    assert.equal((await adapter.dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: modernMeta } })).result.resultType, 'complete');
    assert.deepEqual((await adapter.dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: [] } })).error, { code: -32602, message: 'Invalid params' });
    assert.equal(await adapter.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: 42 } }), null);
  } finally { adapter.close(); }
});
test('modern tools/list succeeds after legacy initialize on one connection', async () => {
  const adapter = startStdioJsonRpc({ info, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    assert.equal((await adapter.dispatch(legacyInitialize(1))).result.protocolVersion, '2025-11-25');
    const modern = await adapter.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: modernMeta } });
    assert.equal(modern.result.resultType, 'complete');
    assert.ok((await adapter.dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools);
  } finally { adapter.close(); }
});
test('legacy initialize succeeds after modern request; plain list still needs initialize', async () => {
  const adapter = startStdioJsonRpc({ info, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    assert.equal((await adapter.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).error.code, -32602);
    assert.equal((await adapter.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: modernMeta } })).result.resultType, 'complete');
    assert.equal((await adapter.dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).error.code, -32602);
    assert.equal((await adapter.dispatch(legacyInitialize(4))).result.protocolVersion, '2025-11-25');
    assert.ok((await adapter.dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/list' })).result.tools);
  } finally { adapter.close(); }
});
test('modern discover leaves legacy initialize available', async () => {
  const adapter = startStdioJsonRpc({ info, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    assert.deepEqual((await adapter.dispatch({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta } })).result.supportedVersions, ['2026-07-28']);
    assert.equal((await adapter.dispatch(legacyInitialize(2))).result.protocolVersion, '2025-11-25');
  } finally { adapter.close(); }
});
test('unsupported modern claims list only the modern protocol version', async () => {
  const adapter = startStdioJsonRpc({ info, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    for (const method of ['initialize', 'tools/list']) {
      const response = await adapter.dispatch({ jsonrpc: '2.0', id: 1, method, params: { _meta: { ...modernMeta, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } } });
      assert.deepEqual(response.error, { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '2025-11-25' } });
    }
  } finally { adapter.close(); }
});
test('modern notification leaves legacy initialize available', async () => {
  const adapter = startStdioJsonRpc({ info, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    assert.equal(await adapter.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: modernMeta } }), null);
    assert.equal((await adapter.dispatch(legacyInitialize(1))).result.protocolVersion, '2025-11-25');
  } finally { adapter.close(); }
});
test('modern initialize metadata leaves legacy initialize available', async () => {
  const adapter = startStdioJsonRpc({ info, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  try {
    assert.equal((await adapter.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { _meta: modernMeta } })).error.code, -32601);
    assert.equal((await adapter.dispatch(legacyInitialize(2))).result.protocolVersion, '2025-11-25');
  } finally { adapter.close(); }
});
test('stdio suppresses the response for a cancelled request id', { timeout: 10000 }, async () => {
  const { fixture } = await import('./fixtures.js');
  let release;
  let seen;
  const reached = new Promise(resolve => { seen = resolve; });
  let answered;
  const finished = new Promise(resolve => { answered = resolve; });
  const f = await fixture(async (_call, res) => { seen(); await new Promise(resolve => { release = resolve; }); res.end('{}'); answered(); });
  const input = new PassThrough(), output = new PassThrough();
  let written = '';
  output.on('data', chunk => { written += chunk; });
  let adapter;
  try {
    adapter = startStdioJsonRpc({ info, stdin: input, stdout: output, stderr: new PassThrough(), config: f.config });
    const call = adapter.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pico_server_info', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }));
    await reached;
    await adapter.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } }));
    release();
    await finished;
    await call;
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].path, '/api/version');
    assert.equal(written, '');
  } finally { release?.(); adapter?.close(); input.end(); output.end(); await f.close(); }
});
test('batch cancellation suppresses only the cancelled element', { timeout: 10000 }, async () => {
  let release, seen;
  const reached = new Promise(resolve => { seen = resolve; });
  const f = await fixture(async (_call, res) => {
    seen();
    await new Promise(resolve => { release = resolve; });
    res.end('{}');
  });
  const input = new PassThrough(), output = new PassThrough();
  let written = '';
  output.on('data', chunk => { written += chunk; });
  let adapter;
  try {
    adapter = startStdioJsonRpc({ info, stdin: input, stdout: output, stderr: new PassThrough(), config: f.config });
    await adapter.handleLine(JSON.stringify(legacyInitialize(0, '2025-03-26')));
    written = '';
    const batch = adapter.handleLine(JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pico_server_info', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'ping' }
    ]));
    await reached;
    await adapter.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }));
    release();
    await batch;
    const replies = written.trim().split('\n').map(JSON.parse);
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], [{ jsonrpc: '2.0', id: 2, result: {} }]);
  } finally { release?.(); adapter?.close(); input.end(); output.end(); await f.close(); }
});

test('stdio cancels a queued tools/call before it reaches Pico', { timeout: 10000 }, async () => {
  const { fixture } = await import('./fixtures.js');
  let release;
  let seen;
  const reached = new Promise(resolve => { seen = resolve; });
  const f = await fixture(async (_call, res) => {
    seen();
    await new Promise(resolve => { release = resolve; });
    res.end(JSON.stringify({ version: '1.4.23' }));
  });
  const input = new PassThrough(), output = new PassThrough();
  let written = '';
  output.on('data', chunk => { written += chunk; });
  let adapter;
  const request = (id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pico_server_info', arguments: {} } });
  try {
    adapter = startStdioJsonRpc({ info, stdin: input, stdout: output, stderr: new PassThrough(), config: { ...f.config, maxConcurrentRequests: 1 } });
    await adapter.handleLine(JSON.stringify(legacyInitialize(0)));
    const first = adapter.handleLine(request(1));
    await reached;
    const queued = adapter.handleLine(request(2));
    await adapter.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }));
    release();
    await Promise.all([first, queued]);
    const lines = written.trim().split('\n').map(JSON.parse).filter(line => line.id !== 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].path, '/api/version');
    assert.deepEqual(lines.map(line => line.id), [1]);
    assert.equal(lines[0].result.structuredContent.version, '1.4.23');
  } finally { release?.(); adapter?.close(); input.end(); output.end(); await f.close(); }
});
