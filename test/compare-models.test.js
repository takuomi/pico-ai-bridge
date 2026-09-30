import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callTool, createContext } from '../server/core/registry.js';
import { fixture } from './fixtures.js';
import { badOllamaDuration, generations } from './fixtures-pico.js';
test('Ollama comparison rows reject nonnumeric durations', async () => {
  for (const field of ['total_duration', 'load_duration', 'prompt_eval_duration', 'eval_duration']) {
    const f = await fixture(() => ({ body: badOllamaDuration(field) }));
    try {
      const response = await callTool('pico_compare_models', { api: 'ollama', models: ['a', 'b'], prompt: 'hi' }, f.ctx);
      assert.deepEqual(response.structuredContent.results.map(row => row.error), Array(2).fill({ source: 'bridge', kind: 'unexpected_response', message: 'Pico /api/chat returned a 2xx body that is not an Ollama chat response.' }));
    } finally { await f.close(); }
  }
});
test('comparison reads images once before any Pico request', async () => {
  let file;
  let requests = 0;
  const f = await fixture(async () => {
    if (file && ++requests === 1) await unlink(file);
    return { body: {} };
  });
  let dir;
  try {
    for (const api of ['responses', 'chat_completions', 'ollama']) {
      const response = await callTool('pico_compare_models', { api, models: ['a', 'b'], prompt: 'hi', images: ['/pico-ai-bridge-nonexistent/image.png'] }, f.ctx);
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent.source, 'bridge');
      assert.equal(response.structuredContent.kind, 'image_read_failed');
    }
    assert.equal(f.calls.length, 0);
    dir = await mkdtemp(join(tmpdir(), 'pico-compare-'));
    file = join(dir, 'image.bin');
    for (const api of ['responses', 'chat_completions', 'ollama']) {
      await writeFile(file, 'img');
      requests = 0;
      const start = f.calls.length;
      await callTool('pico_compare_models', { api, models: ['a', 'b'], prompt: 'hi', images: [file], raw: true }, f.ctx);
      assert.equal(f.calls.length, start + 2);
      const bodies = f.calls.slice(start).map(call => call.body);
      const withoutModel = bodies.map(({ model, ...body }) => body);
      assert.deepEqual(withoutModel[0], withoutModel[1]);
      assert.ok(bodies.every(body => JSON.stringify(body).includes('aW1n')));
      assert.equal(requests, 2);
    }
  } finally { try { if (dir) await rm(dir, { recursive: true, force: true }); } finally { await f.close(); } }
});
test('compare rows include default answers or raw Pico bodies', async () => {
  const body = { choices: [{ message: { role: 'assistant', content: 'yes' } }] };
  const f = await fixture(() => ({ body }));
  try {
    const args = { models: ['a', 'b'], prompt: 'hi', reasoning: 'none', extra: { custom: 1 } };
    const normal = await callTool('pico_compare_models', args, f.ctx);
    const raw = await callTool('pico_compare_models', { ...args, raw: true }, f.ctx);
    assert.deepEqual(normal.structuredContent.results.map(x => x.answer), ['yes', 'yes']);
    assert.deepEqual(raw.structuredContent.results.map(x => x.body), [body, body]);
    assert.deepEqual(f.calls.map(x => x.body.model), ['a', 'b', 'a', 'b']);
    assert.ok(f.calls.every(x => x.body.custom === 1 && x.body.reasoning_effort === 'none'));
  } finally { await f.close(); }
});
test('comparison rows extract API metadata and parse tool arguments from captured Ollama shape', async () => {
  const bodies = {
    '/v1/chat/completions': { id: 'chat-id', model: 'returned', created: 42, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'weather', arguments: '{"city":"Tokyo"}' } }] } }] },
    '/api/chat': generations.ollamaToolCall.response,
    '/v1/responses': { id: 'response-id', model: 'returned', created_at: 1, completed_at: 2, status: 'completed', error: { 'secret-key': 'secret' }, incomplete_details: { reason: 'secret' }, output: [{ type: 'function_call', id: 'f', call_id: 'c', name: 'weather', arguments: '{"city":"Tokyo"}', status: 'completed' }] }
  };
  const f = await fixture(call => ({ body: bodies[call.path] }));
  try {
    for (const [api, expected] of [
      ['chat_completions', { response_id: 'chat-id', created: 42, tool_calls: [{ id: 'c', type: 'function', name: 'weather', arguments: { city: 'Tokyo' } }], finish_reason: 'tool_calls' }],
      ['ollama', { created_at: '2026-09-27T19:08:28Z', done: true, durations_ms: { total: 3517, load: 1653, prompt_eval: null, eval: null }, tool_calls: [{ id: null, name: 'get_weather', arguments: { city: 'Tokyo' } }], finish_reason: null, usage: { prompt_eval_count: null, eval_count: null } }],
      ['responses', { response_id: 'response-id', created_at: 1, completed_at: 2, function_calls: [{ id: 'f', call_id: 'c', name: 'weather', arguments: { city: 'Tokyo' }, status: 'completed' }], status: 'completed', error: { 'secret-key': 'secret' }, incomplete_details: { reason: 'secret' } }]
    ]) {
      const response = await callTool('pico_compare_models', { api, models: ['a', 'b'], prompt: 'hi' }, f.ctx);
      for (const row of response.structuredContent.results) {
        assert.equal(row.response_model, api === 'ollama' ? 'gpt-oss-20b-MXFP4-Q8' : 'returned');
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(row[key], value);
      }
    }
  } finally { await f.close(); }
});
test('Ollama comparison includes done_reason when Pico sends it', async () => {
  const f = await fixture(() => ({ body: { ...generations.ollamaToolCall.response, done_reason: 'stop' } }));
  try {
    const result = await callTool('pico_compare_models', { api: 'ollama', models: ['a', 'b'], prompt: 'hi' }, f.ctx);
    assert.deepEqual(result.structuredContent.results.map(row => row.finish_reason), ['stop', 'stop']);
  } finally { await f.close(); }
});
test('captured Ollama comparison has null finish reason and count usage', async () => {
  const f = await fixture(() => ({ body: generations.ollamaPlain.response }));
  try {
    const result = await callTool('pico_compare_models', { api: 'ollama', models: ['a', 'b'], prompt: 'hi' }, f.ctx);
    for (const row of result.structuredContent.results) {
      assert.equal(row.finish_reason, null);
      assert.deepEqual(row.usage, { prompt_eval_count: null, eval_count: null });
      assert.equal(row.answer, 'The sky is blue on a clear day.');
    }
  } finally { await f.close(); }
});
test('comparison refusal-only and mixed response rows', async () => {
  const bodies = {
    '/v1/chat/completions': { choices: [{ message: { role: 'assistant', refusal: 'secret chat' } }] },
    '/v1/responses': { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'secret ' }, { type: 'output_text', text: 'partial' }] }, { type: 'message', content: [{ type: 'refusal', refusal: 'reply' }] }] }
  };
  const f = await fixture(call => ({ body: bodies[call.path] }));
  try {
    const ctx = createContext({ ...f.config, apiKey: 'secret' });
    for (const [api, answer, refusal] of [['chat_completions', '', '[Redacted] chat'], ['responses', 'partial', '[Redacted] reply']]) {
      const result = await callTool('pico_compare_models', { api, models: ['a', 'b'], prompt: 'hi' }, ctx);
      for (const row of result.structuredContent.results) {
        assert.equal(row.answer, answer);
        assert.equal(row.refusal, refusal);
      }
    }
  } finally { await f.close(); }
});
test('comparison rejects API-specific arguments and duplicate Ollama options before requests', async () => {
  const f = await fixture(() => ({ body: {} }));
  try {
    for (const [args, message] of [
      [{ api: 'ollama', reasoning: 'none' }, 'reasoning applies to responses and chat_completions; use think for ollama.'],
      [{ api: 'responses', think: true }, 'think applies only to the ollama api; use reasoning.'],
      [{ api: 'responses', think: false }, 'think applies only to the ollama api; use reasoning.'],
      [{ api: 'chat_completions', options: {} }, 'options applies only to the ollama api.'],
      [{ api: 'ollama', options: { num_predict: 5 }, max_tokens: 3 }, 'options.num_predict conflicts with max_tokens.'],
      [{ api: 'ollama', options: { temperature: 0.5 }, temperature: 0 }, 'options.temperature conflicts with temperature.'],
      [{ api: 'ollama', options: {}, extra: { options: {} } }, 'extra conflicts with options (use options, max_tokens or temperature).']
    ]) {
      const response = await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi', ...args }, f.ctx);
      assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'invalid_arguments', message });
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('comparison metadata redacts Pico values', async () => {
  const f = await fixture(() => ({ body: { model: 'secret', choices: [{ finish_reason: 'secret', message: { role: 'assistant', content: '', tool_calls: [{ id: 'secret', type: 'function', function: { name: 'secret', arguments: '{"key":"secret"}' } }] } }] } }));
  try {
    const response = await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi' }, createContext({ ...f.config, apiKey: 'secret' }));
    for (const row of response.structuredContent.results) {
      assert.equal(row.response_model, '[Redacted]');
      assert.equal(row.finish_reason, '[Redacted]');
      assert.deepEqual(row.tool_calls, [{ id: '[Redacted]', type: 'function', name: '[Redacted]', arguments: { key: '[Redacted]' } }]);
    }
  } finally { await f.close(); }
});
test('synthetic chat custom calls appear in comparison rows', async () => {
  const body = { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'secret-id', type: 'custom', custom: { name: 'run_code', input: 'print("secret")' } }] } }] };
  const f = await fixture(() => ({ body }));
  try {
    const result = await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi' }, createContext({ ...f.config, apiKey: 'secret' }));
    for (const row of result.structuredContent.results) {
      assert.equal(row.answer, '');
      assert.deepEqual(row.tool_calls, [{ id: '[Redacted]-id', type: 'custom', name: 'run_code', input: 'print("[Redacted]")' }]);
    }
  } finally { await f.close(); }
});
test('synthetic Responses custom calls appear in comparison rows', async () => {
  const body = { output: [{ type: 'custom_tool_call', call_id: 'call_1', name: 'run_code', input: 'print("secret")' }] };
  const f = await fixture(() => ({ body }));
  try {
    const result = await callTool('pico_compare_models', { api: 'responses', models: ['a', 'b'], prompt: 'hi' }, createContext({ ...f.config, apiKey: 'secret' }));
    for (const row of result.structuredContent.results) {
      assert.deepEqual(row.function_calls, []);
      assert.deepEqual(row.custom_tool_calls, [{ id: null, call_id: 'call_1', name: 'run_code', input: 'print("[Redacted]")', status: null }]);
    }
  } finally { await f.close(); }
});
test('comparison Responses error and incomplete details redact Pico keys and values', async () => {
  const body = { output: [], error: { secret: 'secret' }, incomplete_details: { reason: 'secret' } };
  const f = await fixture(() => ({ body }));
  try {
    const response = await callTool('pico_compare_models', { api: 'responses', models: ['a', 'b'], prompt: 'hi' }, createContext({ ...f.config, apiKey: 'secret' }));
    for (const row of response.structuredContent.results) {
      assert.deepEqual(row.error, { '[Redacted]': '[Redacted]' });
      assert.deepEqual(row.incomplete_details, { reason: '[Redacted]' });
    }
  } finally { await f.close(); }
});
test('comparison accepts any number of models, zero max_tokens and empty system', async () => {
  const bodies = { '/v1/chat/completions': { choices: [{ message: { role: 'assistant', content: 'ok' } }] }, '/v1/responses': { output: [] }, '/api/chat': { message: { role: 'assistant', content: 'ok' } } };
  const f = await fixture(call => ({ body: bodies[call.path] }));
  try {
    const models = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const many = await callTool('pico_compare_models', { models, prompt: 'hi', api: 'chat_completions' }, f.ctx);
    assert.equal(f.calls.length, 7);
    assert.equal(many.structuredContent.results.length, 7);
    let before = f.calls.length;
    await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi', max_tokens: 0, system: '' }, f.ctx);
    for (const { body } of f.calls.slice(before)) {
      assert.equal(body.max_tokens, 0);
      assert.equal('max_completion_tokens' in body, false);
      assert.deepEqual(body.messages[0], { role: 'system', content: '' });
    }
    before = f.calls.length;
    await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi', api: 'responses', system: '' }, f.ctx);
    for (const { body } of f.calls.slice(before)) assert.equal(body.instructions, '');
    before = f.calls.length;
    await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi', api: 'ollama', max_tokens: 0 }, f.ctx);
    for (const { body } of f.calls.slice(before)) assert.deepEqual(body.options, { num_predict: 0 });
  } finally { await f.close(); }
});
test('raw comparison records Pico HTTP failures per model and continues', async () => {
  const body = { choices: [{ message: { role: 'assistant', content: 'yes' } }] };
  const f = await fixture(call => call.body.model === 'bad' ? { status: 500, body: { error: 'boom' } } : { body });
  try {
    const raw = await callTool('pico_compare_models', { models: ['bad', 'good'], prompt: 'hi', raw: true }, f.ctx);
    const rows = raw.structuredContent.results;
    assert.equal(raw.isError, undefined);
    assert.equal('status' in rows[0], false);
    assert.equal('body' in rows[0], false);
    assert.deepEqual(rows[0].error, { source: 'pico', status: 500, body: { error: 'boom' } });
    assert.equal(rows[1].status, 200);
    assert.deepEqual(rows[1].body, body);
    assert.deepEqual(f.calls.map(call => call.body.model), ['bad', 'good']);
  } finally { await f.close(); }
});
test('cancellation during a sent comparison stops before the next model', async () => {
  let release;
  let seen;
  const reached = new Promise(resolve => { seen = resolve; });
  const f = await fixture(async (_call, res) => { seen(); await new Promise(resolve => { release = resolve; }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })); });
  try {
    const controller = new AbortController();
    const comparison = callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi' }, f.ctx, { signal: controller.signal });
    await reached;
    controller.abort();
    release();
    const response = await comparison;
    assert.equal(response.structuredContent.kind, 'cancelled');
    assert.deepEqual(f.calls.map(call => call.body.model), ['a']);
  } finally { release?.(); await f.close(); }
});
test('each comparison API records malformed 2xx rows and continues', async () => {
  const cases = [
    ['responses', { output: [] }, '/v1/responses', 'a response'],
    ['chat_completions', { choices: [{ message: { role: 'assistant', content: '' } }] }, '/v1/chat/completions', 'a chat completion'],
    ['ollama', { message: { role: 'assistant', content: '' } }, '/api/chat', 'an Ollama chat response']
  ];
  for (const [api, valid, path, what] of cases) for (const malformed of [{}, null]) {
    const f = await fixture(call => ({ body: call.body.model === 'bad' ? malformed : valid }));
    try {
      const args = { api, models: ['bad', 'good'], prompt: 'hi' };
      const normal = await callTool('pico_compare_models', args, f.ctx);
      assert.equal(normal.isError, undefined);
      assert.deepEqual(normal.structuredContent.results[0].error, { source: 'bridge', kind: 'unexpected_response', message: `Pico ${path} returned a 2xx body that is not ${what}.` });
      assert.equal(normal.structuredContent.results[1].answer, '');
      assert.deepEqual(f.calls.map(call => call.body.model), ['bad', 'good']);
      const raw = await callTool('pico_compare_models', { ...args, raw: true }, f.ctx);
      assert.deepEqual(raw.structuredContent.results.map(row => row.body), [malformed, valid]);
    } finally { await f.close(); }
  }
});
test('comparison sends messages unchanged and attaches images to the last user item', async () => {
  const replies = { '/v1/responses': { output: [] }, '/v1/chat/completions': { choices: [{ message: { role: 'assistant', content: '' } }] }, '/api/chat': { message: { role: 'assistant', content: '' } } };
  const f = await fixture(call => ({ body: replies[call.path] }));
  try {
    for (const api of ['responses', 'chat_completions', 'ollama']) {
      const messages = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'middle' }, { role: 'user', content: 'last' }];
      const start = f.calls.length;
      const result = await callTool('pico_compare_models', { api, models: ['a', 'b'], messages, system: 'rules' }, f.ctx);
      assert.equal(result.isError, undefined);
      for (const { body } of f.calls.slice(start)) {
        if (api === 'responses') { assert.deepEqual(body.input, messages); assert.equal(body.instructions, 'rules'); }
        else assert.deepEqual(body.messages, [{ role: 'system', content: 'rules' }, ...messages]);
      }
      const beforeImages = f.calls.length;
      await callTool('pico_compare_models', { api, models: ['a', 'b'], messages, images: ['data:image/png;base64,YWJj'] }, f.ctx);
      for (const { body } of f.calls.slice(beforeImages)) {
        const sent = api === 'responses' ? body.input : body.messages;
        assert.deepEqual(sent.slice(0, 2), messages.slice(0, 2));
        if (api === 'ollama') assert.deepEqual(sent[2], { role: 'user', content: 'last', images: ['YWJj'] });
        else assert.deepEqual(sent[2].content, api === 'responses'
          ? [{ type: 'input_text', text: 'last' }, { type: 'input_image', image_url: 'data:image/png;base64,YWJj' }]
          : [{ type: 'text', text: 'last' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }]);
      }
      assert.deepEqual(messages[2], { role: 'user', content: 'last' });
    }
  } finally { await f.close(); }
});
test('comparison sends one image-only user item for empty messages', async () => {
  const replies = { '/v1/responses': { output: [] }, '/v1/chat/completions': { choices: [{ message: { role: 'assistant', content: '' } }] }, '/api/chat': { message: { role: 'assistant', content: '' } } };
  const f = await fixture(call => ({ body: replies[call.path] }));
  try {
    for (const api of ['responses', 'chat_completions', 'ollama']) {
      const start = f.calls.length;
      const result = await callTool('pico_compare_models', { api, models: ['a', 'b'], messages: [], images: ['data:image/png;base64,YWJj'] }, f.ctx);
      assert.equal(result.isError, undefined);
      assert.equal(f.calls.length, start + 2);
      for (const { body } of f.calls.slice(start)) {
        const sent = api === 'responses' ? body.input : body.messages;
        assert.deepEqual(sent, api === 'ollama'
          ? [{ role: 'user', content: '', images: ['YWJj'] }]
          : [{ role: 'user', content: [api === 'responses'
            ? { type: 'input_image', image_url: 'data:image/png;base64,YWJj' }
            : { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] }]);
      }
    }
  } finally { await f.close(); }
});
test('comparison accepts images without prompt or messages for all APIs', async () => {
  const replies = { '/v1/responses': { output: [] }, '/v1/chat/completions': { choices: [{ message: { role: 'assistant', content: '' } }] }, '/api/chat': { message: { role: 'assistant', content: '' } } };
  const f = await fixture(call => ({ body: replies[call.path] }));
  try {
    for (const api of ['responses', 'chat_completions', 'ollama']) {
      const start = f.calls.length;
      const response = await callTool('pico_compare_models', { api, models: ['a', 'b'], images: ['data:image/png;base64,YWJj'] }, f.ctx);
      assert.equal(response.isError, undefined);
      assert.equal(f.calls.length, start + 2);
      for (const { body } of f.calls.slice(start)) assert.deepEqual(api === 'responses' ? body.input : body.messages, api === 'ollama'
        ? [{ role: 'user', content: '', images: ['YWJj'] }]
        : [{ role: 'user', content: [api === 'responses' ? { type: 'input_image', image_url: 'data:image/png;base64,YWJj' } : { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] }]);
    }
  } finally { await f.close(); }
});

test('comparison waits for a timed out response before the next model with concurrency two', async () => {
  let finishFirst, firstDone = false, secondEarly = false;
  const firstReached = new Promise(resolve => { finishFirst = resolve; });
  const f = await fixture(async (call, res) => {
    if (call.body.model === 'a') {
      await new Promise(resolve => setTimeout(resolve, 100));
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'late' } }] }));
      firstDone = true;
      finishFirst();
    } else {
      secondEarly = !firstDone;
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    }
  });
  try {
    const response = await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi' }, createContext({ ...f.config, timeoutMs: 30, maxConcurrentRequests: 2 }));
    await firstReached;
    const rows = response.structuredContent.results;
    assert.deepEqual(rows[0].error, { source: 'bridge', kind: 'timeout', message: 'Pico request timed out after 30 ms; the request was not cancelled and keeps its concurrency permit until Pico finishes.' });
    assert.equal(Object.hasOwn(rows[0].error, 'settled'), false);
    assert.equal(rows[1].answer, 'ok');
    assert.equal(secondEarly, false);
  } finally { await f.close(); }
});

test('cancelling while a timed out comparison waits leaves the sent request holding its permit', { timeout: 5000 }, async () => {
  let releaseFirst, sawFirst, sawLater;
  const firstReached = new Promise(resolve => { sawFirst = resolve; });
  const laterReached = new Promise(resolve => { sawLater = resolve; });
  const f = await fixture(async (call, res) => {
    if (call.body.model === 'a') {
      sawFirst();
      await new Promise(resolve => { releaseFirst = resolve; });
    } else if (call.body.model === 'later') sawLater();
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
  try {
    const ctx = createContext({ ...f.config, timeoutMs: 50, maxConcurrentRequests: 1 });
    const controller = new AbortController();
    const comparison = callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi' }, ctx, { signal: controller.signal });
    await firstReached;
    await new Promise(resolve => setTimeout(resolve, 90));
    controller.abort();
    const response = await Promise.race([comparison, new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellation did not finish promptly')), 200))]);
    assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'cancelled', message: 'Request cancelled before the next model was sent to Pico.' });
    assert.deepEqual(f.calls.map(call => call.body.model), ['a']);
    const later = callTool('pico_chat_completions', { model: 'later', prompt: 'hi' }, ctx);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(f.calls.map(call => call.body.model), ['a']);
    releaseFirst();
    await laterReached;
    assert.equal((await later).structuredContent.answer, 'ok');
    assert.deepEqual(f.calls.map(call => call.body.model), ['a', 'later']);
  } finally { releaseFirst?.(); await f.close(); }
});

test('comparison requires exactly one input and names extra conflicts', async () => {
  const f = await fixture(() => ({ body: {} }));
  try {
    for (const [input, message] of [
      [{}, 'Provide prompt, messages or images.'],
      [{ prompt: 'hi', messages: [] }, 'Provide either prompt or messages, not both.'],
      [{ messages: [], api: 'responses', extra: { input: [] } }, 'extra conflicts with input (use prompt or messages).'],
      [{ messages: [], api: 'ollama', extra: { messages: [] } }, 'extra conflicts with messages (use prompt or messages).'],
      [{ prompt: 'hi', api: 'ollama', think: true, extra: { think: false } }, 'extra conflicts with think (use think).']
    ]) {
      const response = await callTool('pico_compare_models', { models: ['a', 'b'], ...input }, f.ctx);
      assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'invalid_arguments', message });
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('comparison records malformed captured call fields for every API', async () => {
  const cases = [
    ['chat_completions', { ...generations.chatToolCallQwen.response, choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f' } }] } }] }],
    ['responses', { ...generations.responsesFunctionCall.response, output: [{ type: 'function_call', name: 'f', call_id: 'c' }] }],
    ['ollama', { ...generations.ollamaToolCall.response, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: [] } }] } }]
  ];
  for (const [api, body] of cases) {
    const f = await fixture(() => ({ body }));
    try {
      const normal = await callTool('pico_compare_models', { api, models: ['a', 'b'], prompt: 'hi' }, f.ctx);
      assert.deepEqual(normal.structuredContent.results.map(row => row.error.kind), ['unexpected_response', 'unexpected_response']);
      const raw = await callTool('pico_compare_models', { api, models: ['a', 'b'], prompt: 'hi', raw: true }, f.ctx);
      assert.deepEqual(raw.structuredContent.results.map(row => row.body), [body, body]);
    } finally { await f.close(); }
  }
});
test('comparison extracts null for absent or null Ollama call arguments', async () => {
  for (const func of [{ name: 'f' }, { name: 'f', arguments: null }]) {
    const body = { message: { role: 'assistant', content: '', tool_calls: [{ function: func, arguments: '{"ignored":true}' }] } };
    const f = await fixture(() => ({ body }));
    try {
      const response = await callTool('pico_compare_models', { api: 'ollama', models: ['a', 'b'], prompt: 'hi' }, f.ctx);
      assert.deepEqual(response.structuredContent.results.map(row => row.tool_calls[0].arguments), [null, null]);
    } finally { await f.close(); }
  }
});
