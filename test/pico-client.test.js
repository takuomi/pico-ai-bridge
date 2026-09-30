import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createPicoClient, errorDetail } from '../server/pico-client.js';
import { callTool, createContext, tools } from '../server/core/registry.js';
import { readConfig } from '../server/core/config.js';
import { errorResult, redact, redactPicoData } from '../server/core/util.js';
import { fixture } from './fixtures.js';
test('Pico errors retain status and body, redact exact configured secrets', async () => {
  const f = await fixture(call => ({ status: 404, body: { error: call.headers.authorization } }));
  try {
    const ctx = createContext({ ...f.config, apiKey: 'secret-value' });
    const r = await callTool('pico_server_info', {}, ctx);
    assert.deepEqual(r.structuredContent, { source: 'pico', status: 404, body: { error: 'Bearer [Redacted]' } });
    assert.equal(r.content[0].text, 'Pico AI Server returned HTTP 404: {"error":"Bearer [Redacted]"}');
    assert.equal(r.content[0].text.includes('Bearer secret-value'), false);
    const raw = await callTool('pico_server_info', { raw: true }, ctx);
    assert.deepEqual(raw.structuredContent, r.structuredContent);
  } finally { await f.close(); }
});
test('base URL credentials reject every tool call without sending a request', async () => {
  const f = await fixture(() => ({ body: { version: 'u:p' } }));
  try {
    const url = f.config.baseUrl.replace('http://', 'http://u:p@');
    for (const userinfo of ['u:p', 'u', ':p']) {
      const config = readConfig({ PICO_BASE_URL: f.config.baseUrl.replace('http://', `http://${userinfo}@`) });
      const ctx = createContext(config);
      for (const name of ['pico_server_info', 'pico_list_models', 'pico_responses', 'pico_chat_completions', 'pico_ollama_chat', 'pico_compare_models']) {
        const r = await callTool(name, {}, ctx);
        assert.deepEqual(r.structuredContent, { source: 'bridge', kind: 'invalid_configuration', message: 'base_url must not contain credentials; use api_key instead.' });
        assert.equal(r.content[0].text, 'Pico AI Bridge error (invalid_configuration): base_url must not contain credentials; use api_key instead.');
      }
    }
    assert.equal(f.calls.length, 0);
    assert.equal(redact(`Failed at ${url} with secret-value`, { baseUrl: url, apiKey: 'secret-value' }), `Failed at ${url} with [Redacted]`);
  } finally { await f.close(); }
});
test('2xx invalid JSON, non-2xx text and empty body', async () => {
  for (const [status, body, expected] of [[200, 'invalid', 'response_parse_failed'], [400, 'plain error', 'pico'], [404, '', 'pico']]) {
    const f = await fixture(() => ({ status, body }));
    try { const r = await callTool('pico_server_info', {}, f.ctx); assert.equal(r.structuredContent.source === 'pico' ? 'pico' : r.structuredContent.kind, expected); }
    finally { await f.close(); }
  }
});
test('invalid JSON message redacts Pico response text', async () => {
  const f = await fixture(() => ({ body: 'bad secret' }));
  try {
    const r = await callTool('pico_server_info', {}, createContext({ ...f.config, apiKey: 'secret' }));
    assert.equal(r.structuredContent.kind, 'response_parse_failed');
    assert.equal(r.structuredContent.message, 'Pico returned invalid JSON: bad [Redacted]');
  } finally { await f.close(); }
});
test('non-finite Pico JSON preserves text in raw and error modes', async () => {
  const body = '{"version":1e309,"nested":{"value":-1e309,"secret":"secret"}}';
  for (const status of [200, 400]) {
    const f = await fixture(() => ({ status, body }));
    try {
      const ctx = createContext({ ...f.config, apiKey: 'secret' });
      const raw = await callTool('pico_server_info', { raw: true }, ctx);
      const normal = await callTool('pico_server_info', {}, ctx);
      if (status === 200) {
        assert.deepEqual(raw.structuredContent, { status, body: body.replaceAll('secret', '[Redacted]') });
        assert.deepEqual(normal.structuredContent, { source: 'bridge', kind: 'response_parse_failed', message: `Pico returned numbers JSON cannot represent exactly: ${body.replaceAll('secret', '[Redacted]')}` });
      } else {
        assert.deepEqual(raw.structuredContent, { source: 'pico', status, body: body.replaceAll('secret', '[Redacted]') });
        assert.deepEqual(normal.structuredContent, raw.structuredContent);
      }
    } finally { await f.close(); }
  }
});
test('unsafe integer Pico JSON keeps original text in raw and error modes', async () => {
  for (const [number, unsafe] of [['9007199254740991', false], ['9007199254740993', true]]) {
    const body = `{"nested":{"n":${number}}}`;
    for (const status of [200, 400]) {
      const f = await fixture(() => ({ status, body }));
      try {
        const raw = await callTool('pico_server_info', { raw: true }, f.ctx);
        const normal = await callTool('pico_server_info', {}, f.ctx);
        if (status === 200 && unsafe) {
          assert.deepEqual(raw.structuredContent, { status, body });
          assert.deepEqual(normal.structuredContent, { source: 'bridge', kind: 'response_parse_failed', message: `Pico returned numbers JSON cannot represent exactly: ${body}` });
        } else if (status === 400) {
          assert.deepEqual(raw.structuredContent, { source: 'pico', status, body: unsafe ? body : JSON.parse(body) });
          assert.deepEqual(normal.structuredContent, raw.structuredContent);
        } else {
          assert.deepEqual(raw.structuredContent, { status, body: JSON.parse(body) });
          assert.equal(normal.structuredContent.kind, undefined);
        }
      } finally { await f.close(); }
    }
  }
});
test('timeout covers response body reading', async () => {
  const f = await fixture(async (_call, res) => { res.writeHead(200); res.write('{'); await new Promise(resolve => setTimeout(resolve, 80)); res.end('}'); });
  try { const r = await callTool('pico_server_info', {}, createContext({ ...f.config, timeoutMs: 20 })); assert.equal(r.structuredContent.kind, 'timeout'); assert.equal(r.structuredContent.message, 'Pico request timed out after 20 ms; the request was not cancelled and keeps its concurrency permit until Pico finishes.'); }
  finally { await f.close(); }
});
test('headers after timeout complete without closing the socket and release the permit', async () => {
  let closedEarly = false, firstFinished = false, secondArrivedEarly = false;
  let finishFirst;
  const finished = new Promise(resolve => { finishFirst = resolve; });
  const f = await fixture(async (call, res) => {
    if (call.path === '/first') {
      res.on('close', () => { if (!res.writableEnded) closedEarly = true; });
      await new Promise(resolve => setTimeout(resolve, 120));
      res.end('{"first":true}');
      firstFinished = res.writableEnded;
      finishFirst();
    } else {
      secondArrivedEarly = !firstFinished;
      res.end('{"second":true}');
    }
  });
  try {
    const request = createPicoClient({ ...f.config, timeoutMs: 30, maxConcurrentRequests: 1 });
    await assert.rejects(request('/first'), error => error.kind === 'timeout');
    assert.equal(firstFinished, false);
    await finished;
    assert.deepEqual((await request('/second')).body, { second: true });
    assert.equal(closedEarly, false);
    assert.equal(secondArrivedEarly, false);
    assert.deepEqual(f.calls.map(call => call.path), ['/first', '/second']);
  } finally { await f.close(); }
});
test('request sends JSON byte length and bearer authorization', async () => {
  const f = await fixture(() => ({ body: {} }));
  try {
    const body = { text: '\u00e9' };
    const request = createPicoClient({ ...f.config, apiKey: 'secret' });
    await request('/post', { method: 'POST', body });
    await request('/get');
    assert.deepEqual(f.calls[0].body, body);
    assert.equal(f.calls[0].headers['content-type'], 'application/json');
    assert.equal(f.calls[0].headers['content-length'], String(Buffer.byteLength(JSON.stringify(body))));
    assert.equal(f.calls[0].headers.authorization, 'Bearer secret');
    assert.equal(f.calls[1].headers['content-length'], undefined);
  } finally { await f.close(); }
});
test('https base URL uses TLS', async () => {
  const f = await fixture(() => ({ body: {} }));
  try {
    const baseUrl = f.config.baseUrl.replace('http:', 'https:');
    await assert.rejects(createPicoClient({ ...f.config, baseUrl })('/api/version'), error => {
      assert.equal(error.kind, 'connection_failed');
      assert.match(error.message, /^Could not connect to https:\/\//);
      assert.match(error.message, /EPROTO|SSL|TLS|wrong version/i);
      return true;
    });
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('raw mode preserves successful text while default reports parse failure', async () => {
  const f = await fixture(() => ({ status: 200, body: 'plain text' }));
  try {
    const raw = await callTool('pico_server_info', { raw: true }, f.ctx);
    assert.deepEqual(raw.structuredContent, { status: 200, body: 'plain text' });
    assert.equal(raw.content[0].text, 'plain text');
    const normal = await callTool('pico_server_info', {}, f.ctx);
    assert.equal(normal.structuredContent.kind, 'response_parse_failed');
    assert.match(normal.structuredContent.message, /plain text/);
  } finally { await f.close(); }
});
test('empty 2xx completion is a successful empty answer', async () => {
  const f = await fixture(() => ({ body: { choices: [{ message: { role: 'assistant', content: '' } }] } }));
  try { const r = await callTool('pico_chat_completions', { prompt: 'hi' }, f.ctx); assert.equal(r.isError, undefined); assert.equal(r.structuredContent.answer, ''); }
  finally { await f.close(); }
});

test('redaction preserves bridge keys and covers Pico keys without a key length threshold', () => {
  const value = { 'x-key': { x: 'x' } };
  assert.deepEqual(redact(value, { apiKey: 'x' }), { 'x-key': { x: '[Redacted]' } });
  assert.deepEqual(redactPicoData(value, { apiKey: 'x' }), { '[Redacted]-key': { '[Redacted]': '[Redacted]' } });
});
test('API keys containing the redaction marker are redacted in Pico data and internal errors', async () => {
  const apiKey = 'ab[Redacted]cd';
  const f = await fixture(() => ({ status: 418, body: { [`key:${apiKey}`]: `value:${apiKey}` } }));
  try {
    const ctx = createContext({ ...f.config, apiKey });
    const pico = await callTool('pico_chat_completions', { prompt: 'hi' }, ctx);
    assert.deepEqual(pico.structuredContent, { source: 'pico', status: 418, body: { 'key:[Redacted]': 'value:[Redacted]' } });
    const infoTool = tools.find(tool => tool.name === 'pico_server_info');
    const originalHandler = infoTool.handler;
    const originalLog = console.error;
    try {
      infoTool.handler = async () => { throw new Error(`runtime ${apiKey}`); };
      console.error = () => {};
      const internal = await callTool('pico_server_info', {}, ctx);
      assert.deepEqual(internal.structuredContent, { source: 'bridge', kind: 'internal_error', message: 'runtime [Redacted]' });
    } finally { infoTool.handler = originalHandler; console.error = originalLog; }
  } finally { await f.close(); }
});
test('synthetic short API keys leave bridge text and caller data intact on real paths', async () => {
  const bridge = (response, kind, message) => {
    assert.deepEqual(response.structuredContent, { source: 'bridge', kind, message });
    assert.equal(response.content[0].text, `Pico AI Bridge error (${kind}): ${message}`);
    assert.equal(response.isError, true);
  };
  const success = (response, expected, text = JSON.stringify(expected)) => {
    assert.deepEqual(response.structuredContent, expected);
    assert.equal(response.content[0].text, text);
    assert.equal(response.isError, undefined);
  };
  for (const apiKey of ['u', 's', 'Pico']) {
    const f = await fixture(call => call.path.endsWith('/api/version')
      ? { body: { version: '1.4.10', name: `token:${apiKey}` } }
      : call.path.endsWith('/api/chat')
        ? { body: { message: { role: 'assistant', content: `token:${apiKey}` } } }
        : call.path.endsWith('/v1/responses')
          ? { body: { output: [{ type: 'message', content: [{ type: 'output_text', text: `token:${apiKey}` }] }] } }
        : call.body?.messages?.[0]?.content === 'error'
          ? { status: 418, body: { detail: `token:${apiKey}` } }
          : { body: { choices: [{ message: { role: 'assistant', content: `token:${apiKey}` } }] } });
    try {
      const config = { ...f.config, baseUrl: `${f.config.baseUrl}/token:${apiKey}`, apiKey };
      const ctx = createContext(config);
      bridge(await callTool('pico_server_info', {}, createContext(readConfig({ PICO_API_KEY: apiKey }))), 'invalid_configuration', 'PICO_BASE_URL is not set; configure base_url.');
      const credentialUrl = f.config.baseUrl.replace('http://', 'http://user:pass@');
      bridge(await callTool('pico_server_info', {}, createContext(readConfig({ PICO_BASE_URL: credentialUrl, PICO_API_KEY: apiKey }))), 'invalid_configuration', 'base_url must not contain credentials; use api_key instead.');
      bridge(await callTool('pico_server_info', { [`field_${apiKey}`]: 1 }, ctx), 'invalid_arguments', `arguments.field_${apiKey} is not allowed`);
      bridge(await callTool('pico_chat_completions', {}, ctx), 'invalid_arguments', 'Provide prompt, messages, images or system.');
      bridge(await callTool('pico_chat_completions', { prompt: 'hi', extra: { messages: [] } }, ctx), 'invalid_arguments', 'extra conflicts with messages (use prompt or messages).');
      bridge(await callTool(`pico_${apiKey}`, {}, ctx), 'unknown_tool', `Unknown tool: pico_${apiKey}`);

      const timeoutFixture = await fixture(async (_call, res) => { await new Promise(resolve => setTimeout(resolve, 80)); res.end('{}'); });
      try {
        const timeoutConfig = { ...timeoutFixture.config, apiKey, timeoutMs: 10 };
        bridge(await callTool('pico_server_info', {}, createContext(timeoutConfig)), 'timeout', 'Pico request timed out after 10 ms; the request was not cancelled and keeps its concurrency permit until Pico finishes.');
      } finally { await timeoutFixture.close(); }

      const probe = createServer();
      let unusedPort;
      try {
        await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
        unusedPort = probe.address().port;
      } finally { if (probe.listening) await new Promise(resolve => probe.close(resolve)); }
      const unreachable = `http://127.0.0.1:${unusedPort}/token:${apiKey}`;
      const unreachableCtx = createContext(readConfig({ PICO_BASE_URL: unreachable, PICO_API_KEY: apiKey }));
      const refusedResult = await callTool('pico_server_info', {}, unreachableCtx);
      const refused = refusedResult.structuredContent.message;
      assert.match(refused, /^Could not connect to /);
      assert.match(refused, /ECONNREFUSED/);
      bridge(refusedResult, 'connection_failed', refused);
      const compareFailure = await callTool('pico_compare_models', { models: [`token:${apiKey}`, 'gpt-oss'], prompt: 'hi' }, unreachableCtx);
      const failedRows = [`token:${apiKey}`, 'gpt-oss'].map((model, index) => {
        const elapsed_ms = compareFailure.structuredContent.results[index].elapsed_ms;
        assert.equal(Number.isInteger(elapsed_ms), true);
        return { model, elapsed_ms, error: { source: 'bridge', kind: 'connection_failed', message: refused } };
      });
      success(compareFailure, { api: 'chat_completions', results: failedRows });

      const broken = await fixture(async (_call, res) => { res.writeHead(200); await new Promise(resolve => res.write('{', resolve)); await new Promise(resolve => setTimeout(resolve, 20)); res.destroy(); });
      try {
        const brokenConfig = { ...broken.config, apiKey };
        const read = await callTool('pico_server_info', {}, createContext(brokenConfig));
        assert.equal(read.structuredContent.kind, 'connection_failed');
        assert.match(read.structuredContent.message, /^Could not read response from /);
        const detail = read.structuredContent.message.slice(`Could not read response from ${brokenConfig.baseUrl}: `.length);
        assert.equal(detail.includes(apiKey), false);
      } finally { await broken.close(); }

      const controller = new AbortController();
      controller.abort();
      await assert.rejects(createPicoClient(config)('/api/version', { signal: controller.signal }), error => {
        bridge(errorResult(error, config), 'cancelled', 'Request cancelled before it was sent to Pico.');
        return true;
      });
      const imagePath = `__missing_${apiKey}_${process.pid}.png`;
      bridge(await callTool('pico_chat_completions', { prompt: 'hi', images: [imagePath] }, ctx), 'image_read_failed', `Could not read image ${imagePath}: ENOENT`);

      const infoTool = tools.find(tool => tool.name === 'pico_server_info');
      const originalHandler = infoTool.handler;
      const originalLog = console.error;
      const logs = [];
      try {
        infoTool.handler = async () => { throw new Error(`runtime ${apiKey}`); };
        console.error = line => logs.push(line);
        bridge(await callTool('pico_server_info', {}, ctx), 'internal_error', `runtime ${apiKey}`.replaceAll(apiKey, '[Redacted]'));
      } finally { infoTool.handler = originalHandler; console.error = originalLog; }
      assert.equal(logs.length, 1);
      assert.equal(logs[0].includes(`runtime ${apiKey}`), false);

      const pico = await callTool('pico_chat_completions', { prompt: 'error' }, ctx);
      assert.deepEqual(pico.structuredContent, { source: 'pico', status: 418, body: { detail: 'token:[Redacted]' } });
      assert.equal(pico.content[0].text, 'Pico AI Server returned HTTP 418: {"detail":"token:[Redacted]"}');
      assert.equal(pico.isError, true);
      const versionKey = apiKey === 's' ? 'ver[Redacted]ion' : 'version';
      const rawInfo = { status: 200, body: { [versionKey]: '1.4.10', name: 'token:[Redacted]' } };
      success(await callTool('pico_server_info', { raw: true }, ctx), rawInfo, JSON.stringify(rawInfo.body));
      success(await callTool('pico_server_info', {}, ctx), { reachable: true, base_url: config.baseUrl, version: '1.4.10', name: 'token:[Redacted]', build: null, bundle_identifier: null });
      success(await callTool('pico_server_info', {}, { ...ctx, request: async () => ({ status: 200, body: {} }) }), { reachable: true, base_url: config.baseUrl, version: null, name: null, build: null, bundle_identifier: null });
      success(await callTool('pico_ollama_chat', { prompt: 'hi' }, ctx), { answer: 'token:[Redacted]', reasoning: '', usage: { prompt_eval_count: null, eval_count: null }, durations_ms: { total: null, load: null, prompt_eval: null, eval: null }, finish_reason: null, response_model: null, created_at: null, done: null, tool_calls: [] });

      for (const raw of [false, true]) {
        const models = [`token:${apiKey}`, 'gpt-oss'];
        for (const api of ['chat_completions', 'responses']) {
          const compared = await callTool('pico_compare_models', { models, prompt: 'hi', raw, api }, ctx);
          const rows = models.map((model, index) => {
            const elapsed_ms = compared.structuredContent.results[index].elapsed_ms;
            assert.equal(Number.isInteger(elapsed_ms), true);
            const body = api === 'responses'
              ? { output: [{ type: 'message', content: [{ type: 'output_text', text: `token:${apiKey}` }] }] }
              : { choices: [{ message: { role: 'assistant', content: `token:${apiKey}` } }] };
            return raw ? { model, status: 200, body: redactPicoData(body, config), elapsed_ms }
              : { model, answer: 'token:[Redacted]', refusal: null, reasoning: '', response_model: null, response_id: null,
                ...(api === 'responses' ? { created_at: null, completed_at: null, function_calls: [], custom_tool_calls: [], status: null, error: null, incomplete_details: null } : { created: null, tool_calls: [], finish_reason: null }), elapsed_ms };
          });
          success(compared, { api, results: rows });
        }
      }
    } finally { await f.close(); }
  }
});
test('short API key preserves bridge field names and redacts Pico values', async () => {
  const f = await fixture(() => ({ body: { id: 'r', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'token:s', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{"city":"s"}' } }] } }], usage: { prompt_tokens: 1 } } }));
  try {
    const r = await callTool('pico_chat_completions', { prompt: 'hi' }, createContext({ ...f.config, apiKey: 's' }));
    assert.deepEqual(r.structuredContent, { answer: 'token:[Redacted]', refusal: null, reasoning: '', tool_calls: [{ id: 'c', type: 'function', name: 'f', arguments: { city: '[Redacted]' } }], finish_reason: '[Redacted]top', usage: { 'prompt_token[Redacted]': 1 }, response_id: 'r', response_model: null, created: null });
    assert.equal(r.isError, undefined);
  } finally { await f.close(); }
});
test('connection failures include each aggregate cause', () => {
  const config = { baseUrl: 'http://localhost:7426', timeoutMs: 1000 };
  const first = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7426'), { code: 'ECONNREFUSED' });
  const second = Object.assign(new Error('connect EHOSTUNREACH ::1:7426'), { code: 'EHOSTUNREACH' });
  const aggregate = new AggregateError([first, second], 'attempts failed');
  const details = 'ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:7426; EHOSTUNREACH: connect EHOSTUNREACH ::1:7426';
  assert.equal(errorDetail(aggregate, config), `attempts failed (${details})`);
  assert.equal(errorDetail(new Error('connect failed', { cause: aggregate }), config), `connect failed (${details})`);
});
test('connection failure redacts an API key in the socket error', async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  await assert.rejects(createPicoClient({ baseUrl, timeoutMs: 1000, apiKey: 'connect' })('/api/version'), error => {
    assert.equal(error.kind, 'connection_failed');
    assert.match(error.message, /^Could not connect to /);
    assert.match(error.message, /ECONNREFUSED/);
    assert.match(error.message, /\[Redacted\]/);
    assert.equal(error.message.slice(`Could not connect to ${baseUrl}: `.length).includes('connect'), false);
    return true;
  });
});
test('response read cause redacts the configured API key', () => {
  const config = { baseUrl: 'http://localhost:7426', timeoutMs: 1000, apiKey: 'Could' };
  const failure = new Error('read failed', { cause: Object.assign(new Error('socket closed for Could'), { code: 'UND_ERR_SOCKET' }) });
  assert.equal(errorDetail(failure, config), 'read failed (UND_ERR_SOCKET: socket closed for [Redacted])');
});
test('Pico object keys and nested values are redacted in raw results, errors, and model listings', async () => {
  const apiKey = 'secret';
  const body = { [`outer-${apiKey}`]: { nested: [`value ${apiKey}`] } };
  const expected = { 'outer-[Redacted]': { nested: ['value [Redacted]'] } };
  const f = await fixture(call => call.path === '/api/version' || call.path === '/v1/models'
    ? { body: call.path === '/v1/models' ? { data: [], ...body } : body }
    : call.path === '/api/tags' ? { body: { models: [], ...body } } : { status: 400, body });
  try {
    const ctx = createContext({ ...f.config, apiKey });
    const raw = await callTool('pico_server_info', { raw: true }, ctx);
    assert.deepEqual(raw.structuredContent.body, expected);
    assert.deepEqual(JSON.parse(raw.content[0].text), expected);
    const pico = await callTool('pico_chat_completions', { prompt: 'hi' }, ctx);
    assert.deepEqual(pico.structuredContent.body, expected);
    const models = await callTool('pico_list_models', { raw: true }, ctx);
    assert.deepEqual(models.structuredContent.v1_models.body['outer-[Redacted]'], expected['outer-[Redacted]']);
    assert.deepEqual(models.structuredContent.api_tags.body['outer-[Redacted]'], expected['outer-[Redacted]']);
    assert.deepEqual(JSON.parse(models.content[0].text), models.structuredContent);
  } finally { await f.close(); }
});
test('redirect is returned as a Pico error without contacting its target', async () => {
  const target = await fixture(() => ({ body: { reached: true } }));
  let source;
  try {
    source = await fixture((_call, res) => { res.writeHead(307, { location: `${target.config.baseUrl}/target` }); res.end('redirected'); });
    const response = await callTool('pico_server_info', {}, source.ctx);
    assert.deepEqual(response.structuredContent, { source: 'pico', status: 307, body: 'redirected' });
    assert.equal(response.isError, true);
    assert.equal(target.calls.length, 0);
  } finally { try { await source?.close(); } finally { await target.close(); } }
});

test('synchronous abort after request acquisition sends no request and releases the permit', async () => {
  const f = await fixture(() => ({ body: {} }));
  try {
    const controller = new AbortController();
    const pending = f.ctx.request('/cancelled', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.kind === 'cancelled');
    assert.equal(f.calls.length, 0);
    await f.ctx.request('/next');
    assert.deepEqual(f.calls.map(call => call.path), ['/next']);
  } finally { await f.close(); }
});
