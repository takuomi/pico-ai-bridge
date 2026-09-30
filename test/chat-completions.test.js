import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../server/core/registry.js';
import { fixture } from './fixtures.js';
import { generations } from './fixtures-pico.js';
test('pico_chat_completions raw, extraction, and extra', async () => {
  const body = { choices: [{ message: { role: 'assistant', content: '<think>why</think>yes' }, finish_reason: 'stop' }] };
  const f = await fixture(() => ({ body }));
  try {
    const args = { prompt: 'hello', extra: { custom: 1 } };
    const normal = await callTool('pico_chat_completions', args, f.ctx);
    const raw = await callTool('pico_chat_completions', { ...args, raw: true }, f.ctx);
    assert.equal(normal.structuredContent.answer, 'yes');
    assert.equal(normal.structuredContent.reasoning, 'why');
    assert.deepEqual(raw.structuredContent, { status: 200, body });
    assert.equal(f.calls[0].path, '/v1/chat/completions');
    assert.equal('model' in f.calls[0].body, false);
    assert.equal(f.calls[0].body.custom, 1);
  } finally { await f.close(); }
});
test('chat refusal-only and mixed replies expose redacted refusal', async () => {
  for (const content of [null, undefined, 'partial answer']) {
    const body = { choices: [{ message: { role: 'assistant', ...(content === undefined ? {} : { content }), refusal: 'secret refusal' } }] };
    const f = await fixture(() => ({ body }));
    try {
      const result = await callTool('pico_chat_completions', { prompt: 'hi' }, { ...f.ctx, config: { ...f.config, apiKey: 'secret' } });
      assert.equal(result.structuredContent.refusal, '[Redacted] refusal');
      assert.equal(result.structuredContent.answer, content ?? '');
    } finally { await f.close(); }
  }
});
test('chat reasoning_effort, zero max_tokens and empty system pass unchanged', async () => {
  const f = await fixture(() => ({ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } }));
  try {
    await callTool('pico_chat_completions', { prompt: 'hi', reasoning_effort: 'xhigh' }, f.ctx);
    await callTool('pico_chat_completions', { prompt: 'hi', reasoning_effort: 'custom' }, f.ctx);
    assert.deepEqual(f.calls.map(call => call.body.reasoning_effort), ['xhigh', 'custom']);
    await callTool('pico_chat_completions', { prompt: 'hi', max_tokens: 0, system: '' }, f.ctx);
    assert.equal(f.calls[2].body.max_tokens, 0);
    assert.equal('max_completion_tokens' in f.calls[2].body, false);
    assert.deepEqual(f.calls[2].body.messages[0], { role: 'system', content: '' });
  } finally { await f.close(); }
});
test('chat allows extra max_completion_tokens', async () => {
  const f = await fixture(() => ({ body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } }));
  try {
    const response = await callTool('pico_chat_completions', { prompt: 'hi', max_tokens: 5, extra: { max_completion_tokens: 7 } }, f.ctx);
    assert.equal(response.isError, undefined);
    assert.equal(f.calls[0].body.max_tokens, 5);
    assert.equal(f.calls[0].body.max_completion_tokens, 7);
  } finally { await f.close(); }
});
test('chat completion checks 2xx shape only in default mode', async () => {
  for (const body of [{}, null, { choices: [{ message: { content: '' } }] }, { choices: [{ message: { role: 'assistant', content: 1 } }] }, { choices: [{ message: { role: 'assistant', content: '', refusal: 1 } }] }, { choices: [{ message: { role: 'assistant', content: '', tool_calls: {} } }] }, { choices: [{ message: { role: 'assistant', content: '', tool_calls: [null] } }] }, { choices: [{ message: { role: 'assistant', content: '', reasoning_content: {} } }] }, { choices: [{ message: { role: 'assistant', content: '', reasoning: 1 } }] },
    ...[null, {}, { function: {} }, { function: { name: 1 } }].map(call => ({ ...generations.chatToolCall.response, choices: [{ ...generations.chatToolCall.response.choices[0], message: { ...generations.chatToolCall.response.choices[0].message, tool_calls: [call] } }] }))]) {
    const f = await fixture(() => ({ body }));
    try {
      const normal = await callTool('pico_chat_completions', { prompt: 'hi' }, f.ctx);
      assert.deepEqual(normal.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: 'Pico /v1/chat/completions returned a 2xx body that is not a chat completion.' });
      assert.equal(normal.isError, true);
      assert.deepEqual((await callTool('pico_chat_completions', { prompt: 'hi', raw: true }, f.ctx)).structuredContent, { status: 200, body });
    } finally { await f.close(); }
  }
  const f = await fixture(() => ({ body: { choices: [{ message: { role: 'assistant', content: '' } }] } }));
  try { assert.equal((await callTool('pico_chat_completions', { prompt: 'hi' }, f.ctx)).structuredContent.answer, ''); }
  finally { await f.close(); }
});
test('chat accepts null or absent content without calls or refusal as an empty answer', async () => {
  for (const message of [{ role: 'assistant', content: null }, { role: 'assistant' }, { role: 'assistant', tool_calls: [] }, { role: 'assistant', refusal: null }]) {
    const body = { choices: [{ message, finish_reason: 'content_filter' }] };
    const f = await fixture(() => ({ body }));
    try {
      const normal = await callTool('pico_chat_completions', { prompt: 'hi' }, f.ctx);
      assert.equal(normal.isError, undefined);
      assert.equal(normal.structuredContent.answer, '');
      assert.equal(normal.structuredContent.refusal, null);
      assert.deepEqual(normal.structuredContent.tool_calls, []);
      assert.equal(normal.structuredContent.finish_reason, 'content_filter');
      const compared = await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi' }, f.ctx);
      for (const row of compared.structuredContent.results) {
        assert.equal(row.error, undefined);
        assert.equal(row.answer, '');
        assert.equal(row.finish_reason, 'content_filter');
      }
    } finally { await f.close(); }
  }
});
test('chat rejects missing or wrong captured tool-call fields', async () => {
  const captured = generations.chatToolCallQwen.response;
  const original = captured.choices[0].message.tool_calls[0];
  for (const [field, value] of [['id', undefined], ['id', 1], ['type', undefined], ['type', 1], ['function', null], ['function', { arguments: '{}' }], ['function', { name: 1, arguments: '{}' }], ['function', { name: 'get_weather' }], ['function', { name: 'get_weather', arguments: {} }]]) {
    const call = { ...original, [field]: value };
    const body = { ...captured, choices: [{ ...captured.choices[0], message: { ...captured.choices[0].message, tool_calls: [call] } }] };
    const f = await fixture(() => ({ body }));
    try {
      assert.equal((await callTool('pico_chat_completions', { prompt: 'hi' }, f.ctx)).structuredContent.kind, 'unexpected_response');
      assert.deepEqual((await callTool('pico_chat_completions', { prompt: 'hi', raw: true }, f.ctx)).structuredContent.body, JSON.parse(JSON.stringify(body)));
    } finally { await f.close(); }
  }
});
test('synthetic chat custom call accepts null content and redacts free-text input', async () => {
  const body = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'custom', custom: { name: 'run_code', input: 'print("secret")' } }] } }] };
  const f = await fixture(() => ({ body }));
  try {
    const ctx = { ...f.ctx, config: { ...f.config, apiKey: 'secret' } };
    const normal = await callTool('pico_chat_completions', { prompt: 'hi' }, ctx);
    assert.equal(normal.structuredContent.answer, '');
    assert.deepEqual(normal.structuredContent.tool_calls, [{ id: 'call_1', type: 'custom', name: 'run_code', input: 'print("[Redacted]")' }]);
    assert.deepEqual((await callTool('pico_chat_completions', { prompt: 'hi', raw: true }, f.ctx)).structuredContent.body, body);
  } finally { await f.close(); }
});
test('synthetic chat custom call rejects missing name or input', async () => {
  for (const custom of [{ input: 'print(1)' }, { name: 'run_code' }, { name: 'run_code', input: {} }]) {
    const body = { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'custom', custom }] } }] };
    const f = await fixture(() => ({ body }));
    try { assert.equal((await callTool('pico_chat_completions', { prompt: 'hi' }, f.ctx)).structuredContent.kind, 'unexpected_response'); }
    finally { await f.close(); }
  }
});
