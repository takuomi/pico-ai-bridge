import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../server/core/registry.js';
import { fixture } from './fixtures.js';
import { badOllamaDuration, generations } from './fixtures-pico.js';
test('Ollama rejects nonnumeric durations in default mode', async () => {
  for (const field of ['total_duration', 'load_duration', 'prompt_eval_duration', 'eval_duration']) {
    const body = badOllamaDuration(field);
    const f = await fixture(() => ({ body }));
    try {
      const normal = await callTool('pico_ollama_chat', { prompt: 'hi' }, f.ctx);
      assert.deepEqual(normal.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: 'Pico /api/chat returned a 2xx body that is not an Ollama chat response.' });
      const raw = await callTool('pico_ollama_chat', { prompt: 'hi', raw: true }, f.ctx);
      assert.deepEqual(raw.structuredContent.body, body);
    } finally { await f.close(); }
  }
});
test('Ollama rejects nonfinite duration parsed from JSON', async () => {
  const f = await fixture(() => ({ body: '{"message":{"role":"assistant","content":"ok"},"eval_duration":1e309}' }));
  try {
    const response = await callTool('pico_ollama_chat', { prompt: 'hi' }, f.ctx);
    assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'response_parse_failed', message: 'Pico returned numbers JSON cannot represent exactly: {"message":{"role":"assistant","content":"ok"},"eval_duration":1e309}' });
    const raw = await callTool('pico_ollama_chat', { prompt: 'hi', raw: true }, f.ctx);
    assert.equal(raw.structuredContent.body, '{"message":{"role":"assistant","content":"ok"},"eval_duration":1e309}');
  } finally { await f.close(); }
});
test('spec-shaped synthetic pico_ollama_chat raw, extraction, and extra', async () => {
  const body = { message: { role: 'assistant', content: '<think>why</think>yes' }, done_reason: 'stop' };
  const f = await fixture(() => ({ body }));
  try {
    const args = { prompt: 'hello', extra: { custom: 1 } };
    const normal = await callTool('pico_ollama_chat', args, f.ctx);
    const raw = await callTool('pico_ollama_chat', { ...args, raw: true }, f.ctx);
    assert.equal(normal.structuredContent.answer, 'yes');
    assert.equal(normal.structuredContent.reasoning, 'why');
    assert.deepEqual(raw.structuredContent, { status: 200, body });
    assert.equal(f.calls[0].path, '/api/chat');
    assert.equal('model' in f.calls[0].body, false);
    assert.equal(f.calls[0].body.custom, 1);
  } finally { await f.close(); }
});
test('Ollama omits absent messages and preserves an empty array', async () => {
  const missing = { error: 'Coding key `messages` not found.' }, empty = { error: 'No chat messages found' };
  const f = await fixture(call => ({ status: 400, body: Object.hasOwn(call.body, 'messages') ? empty : missing }));
  try {
    for (const [args, body] of [[{}, missing], [{ messages: [] }, empty]]) {
      assert.deepEqual((await callTool('pico_ollama_chat', args, f.ctx)).structuredContent, { source: 'pico', status: 400, body });
      assert.deepEqual((await callTool('pico_ollama_chat', { ...args, raw: true }, f.ctx)).structuredContent, { source: 'pico', status: 400, body });
    }
    assert.equal(Object.hasOwn(f.calls[0].body, 'messages'), false);
    assert.equal(Object.hasOwn(f.calls[1].body, 'messages'), false);
    assert.deepEqual(f.calls[2].body.messages, []);
    assert.deepEqual(f.calls[3].body.messages, []);
  } finally { await f.close(); }
});
test('ollama sends an empty system message', async () => {
  const f = await fixture(() => ({ body: { message: { role: 'assistant', content: 'ok' } } }));
  try {
    await callTool('pico_ollama_chat', { prompt: 'hi', system: '' }, f.ctx);
    assert.deepEqual(f.calls[0].body.messages[0], { role: 'system', content: '' });
  } finally { await f.close(); }
});
test('Ollama think sends booleans, and extra.think sends level strings and null unchanged', async () => {
  const body = { error: 'Type mismatch for `think` key, expected `Bool` type.' };
  const f = await fixture(call => call.body.think === 'low' ? { status: 400, body } : { body: generations.ollamaPlain.response });
  try {
    for (const value of ['low', 'true', null]) {
      assert.deepEqual((await callTool('pico_ollama_chat', { prompt: 'hi', think: value }, f.ctx)).structuredContent,
        { source: 'bridge', kind: 'invalid_arguments', message: 'arguments.think must be boolean' });
    }
    assert.equal(f.calls.length, 0);
    for (const think of [true, false, 'low', null]) {
      const response = await callTool('pico_ollama_chat', { prompt: 'hi', ...(typeof think === 'boolean' ? { think } : { extra: { think } }) }, f.ctx);
      assert.equal(f.calls.at(-1).body.think, think);
      if (think === 'low') {
        assert.equal(response.isError, true);
        assert.deepEqual(response.structuredContent, { source: 'pico', status: 400, body });
      } else {
        assert.equal(response.isError, undefined);
        assert.equal(response.structuredContent.created_at, generations.ollamaPlain.response.created_at);
        assert.equal(response.structuredContent.done, true);
      }
    }
  } finally { await f.close(); }
});
test('Ollama chat checks 2xx shape only in default mode', async () => {
  for (const body of [{}, null, { message: { content: '' } }, { message: { role: 'assistant' } }, { message: { role: 'assistant', content: null } }, { message: { role: 'assistant', content: '', tool_calls: {} } }, { message: { role: 'assistant', content: '', tool_calls: [null] } }, { message: { role: 'assistant', content: '', thinking: {} } },
    ...[{}, { function: {} }, { function: { name: 1 } }].map(call => ({ ...generations.ollamaToolCall.response, message: { ...generations.ollamaToolCall.response.message, tool_calls: [call] } }))]) {
    const f = await fixture(() => ({ body }));
    try {
      const normal = await callTool('pico_ollama_chat', { prompt: 'hi' }, f.ctx);
      assert.deepEqual(normal.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: 'Pico /api/chat returned a 2xx body that is not an Ollama chat response.' });
      assert.equal(normal.isError, true);
      assert.deepEqual((await callTool('pico_ollama_chat', { prompt: 'hi', raw: true }, f.ctx)).structuredContent, { status: 200, body });
    } finally { await f.close(); }
  }
  const f = await fixture(() => ({ body: { message: { role: 'assistant', content: '' } } }));
  try { assert.equal((await callTool('pico_ollama_chat', { prompt: 'hi' }, f.ctx)).structuredContent.answer, ''); }
  finally { await f.close(); }
});
test('Ollama rejects malformed captured function calls and accepts optional arguments', async () => {
  const captured = generations.ollamaToolCall.response;
  const original = captured.message.tool_calls[0];
  for (const [field, value] of [['function', undefined], ['function', { arguments: {} }], ['function', { name: 1, arguments: {} }], ['function', { name: 'get_weather', arguments: [] }]]) {
    const body = { ...captured, message: { ...captured.message, tool_calls: [{ ...original, [field]: value }] } };
    const f = await fixture(() => ({ body }));
    try {
      assert.equal((await callTool('pico_ollama_chat', { prompt: 'hi' }, f.ctx)).structuredContent.kind, 'unexpected_response');
      assert.deepEqual((await callTool('pico_ollama_chat', { prompt: 'hi', raw: true }, f.ctx)).structuredContent.body, JSON.parse(JSON.stringify(body)));
    } finally { await f.close(); }
  }
  for (const [func, expected] of [[{ name: 'f' }, null], [{ name: 'f', arguments: null }, null], [{ name: 'f', arguments: '{"x":1}' }, { x: 1 }]]) {
    const body = { message: { role: 'assistant', content: '', tool_calls: [{ function: func }] } };
    const f = await fixture(() => ({ body }));
    try { assert.deepEqual((await callTool('pico_ollama_chat', { prompt: 'hi' }, f.ctx)).structuredContent.tool_calls[0].arguments, expected); }
    finally { await f.close(); }
  }
});
